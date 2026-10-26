import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { CATEGORIES, type Snapshot } from '../src/game.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8791';
let server: ReturnType<typeof spawn> | undefined;
let temporary = '';
let serverLog = '';

before(
	async () => {
		if (!process.env.TEST_BASE_URL) {
			temporary = await mkdtemp(join(tmpdir(), 'yahtzee-integration-'));
			server = spawn(
				process.execPath,
				['node_modules/wrangler/bin/wrangler.js', 'dev', '--port', '8791', '--persist-to', join(temporary, 'state')],
				{
					cwd: process.cwd(),
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe'],
					env: {
						...process.env,
						WRANGLER_LOG_PATH: join(temporary, 'wrangler.log'),
						WRANGLER_REGISTRY_PATH: join(temporary, 'registry'),
						WRANGLER_SEND_METRICS: 'false',
						CHOKIDAR_USEPOLLING: '1',
					},
				},
			);
			for (const stream of [server.stdout, server.stderr])
				stream?.on('data', (chunk) => {
					serverLog = (serverLog + String(chunk)).slice(-15000);
				});
		}
		for (let attempt = 0; attempt < 150; attempt++) {
			try {
				if ((await fetch(base)).ok) return;
			} catch {
				/* Wait for workerd to listen. */
			}
			if (server?.exitCode !== undefined && server?.exitCode !== null) throw new Error(serverLog);
			await delay(200);
		}
		throw new Error(`Local Worker did not start.\n${serverLog}`);
	},
	{ timeout: 40000 },
);

after(async () => {
	if (server?.pid) {
		const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
		try {
			process.kill(-server.pid, 'SIGTERM');
		} catch {
			/* Already stopped. */
		}
		await Promise.race([exited, delay(2000)]);
	}
	if (temporary) await rm(temporary, { recursive: true, force: true });
});

let clientNumber = 0;
function client(ip = '192.0.2.' + ++clientNumber) {
	let cookie = '';
	return {
		get cookie() {
			return cookie;
		},
		async call(path = '', method = 'GET', body?: unknown) {
			const response = await fetch(`${base}/api/rooms${path}`, {
				method,
				headers: { 'Content-Type': 'application/json', Cookie: cookie, 'CF-Connecting-IP': ip },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
			return { status: response.status, data: (await response.json()) as Snapshot & { error?: string }, headers: response.headers };
		},
	};
}

test(
	'実際のWorkerで参加人数・権限・同期・復帰・13ターンの終了を検証する',
	async () => {
		const host = client();
		const guest = client();
		const outsider = client();
		const created = await host.call('', 'POST', { name: 'ホスト' });
		assert.equal(created.status, 201);
		assert.equal(created.data.room.straightRule, 'standard');
		assert.match(created.headers.get('set-cookie')!, /HttpOnly/);
		assert.equal(created.headers.get('cache-control'), 'no-store');
		assert.ok(!JSON.stringify(created.data).includes('sessionHash'));
		const code = created.data.room.code;
		assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
		assert.equal((await host.call(`/${code}/start`, 'POST', {})).status, 409);
		assert.equal(
			(await outsider.call(`/${code}/score`, 'PUT', { category: 'ones', value: 3, extraYahtzee: false, version: 0 })).status,
			403,
		);
		const joined = await guest.call(`/${code}/join`, 'POST', { name: 'ゲスト' });
		assert.equal(joined.status, 200);
		assert.notEqual(created.data.playerId, joined.data.playerId);
		assert.equal((await guest.call(`/${code}/start`, 'POST', {})).status, 403);
		assert.equal((await host.call(`/${code}/join`, 'POST', { name: '重複' })).data.room.players.length, 2);

		const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${code}/live`, { headers: { Cookie: guest.cookie } });
		const states: Snapshot[] = [];
		ws.on('message', (raw) => {
			if (raw.toString() !== 'pong') states.push(JSON.parse(raw.toString()));
		});
		const waitFor = async (predicate: (state: Snapshot) => boolean) => {
			for (let i = 0; i < 100; i++) {
				const snapshot = states.findLast(predicate);
				if (snapshot) return snapshot;
				await delay(30);
			}
			assert.fail('WebSocket update did not arrive');
		};
		try {
			await waitFor((state) => state.room.status === 'lobby');
			assert.equal((await host.call(`/${code}/start`, 'POST', {})).status, 200);
			await waitFor((state) => state.room.status === 'playing');
			assert.equal((await outsider.call(`/${code}/join`, 'POST', { name: '途中参加' })).status, 409);
			const simultaneous = await Promise.all([
				host.call(`/${code}/score`, 'PUT', { category: 'ones', value: 3, extraYahtzee: false, version: 0 }),
				guest.call(`/${code}/score`, 'PUT', { category: 'twos', value: 6, extraYahtzee: false, version: 0 }),
			]);
			assert.deepEqual(
				simultaneous.map((response) => response.status),
				[200, 200],
			);
			const synced = await waitFor(
				(state) => state.room.players[0].scores.ones?.value === 3 && state.room.players[1].scores.twos?.value === 6,
			);
			assert.equal(synced.playerId, joined.data.playerId);
			assert.equal((await host.call(`/${code}/score`, 'PUT', { category: 'ones', value: 5, extraYahtzee: false, version: 0 })).status, 409);
			assert.equal(
				(await host.call(`/${code}/score`, 'PUT', { category: 'ones', value: 99, extraYahtzee: false, version: 1 })).status,
				400,
			);
			assert.equal((await host.call(`/${code}/name`, 'PUT', { name: '  新しい名前  ' })).status, 200);
			await waitFor((state) => state.room.players[0].name === '新しい名前');
			const restored = await host.call(`/${code}`);
			assert.equal(restored.data.playerId, created.data.playerId);
			assert.equal(restored.data.room.players[0].scores.ones?.value, 3);
			assert.equal((await outsider.call(`/${code}`)).data.playerId, null);
			for (const actor of [host, guest]) {
				let snapshot = (await actor.call(`/${code}`)).data;
				for (const category of CATEGORIES) {
					const player = snapshot.room.players.find((item) => item.id === snapshot.playerId)!;
					if (player.scores[category.id]) continue;
					const response = await actor.call(`/${code}/score`, 'PUT', {
						category: category.id,
						value: 0,
						extraYahtzee: false,
						version: player.version,
					});
					assert.equal(response.status, 200, response.data.error);
					snapshot = response.data;
				}
			}
			const finished = await waitFor((state) => state.room.status === 'finished');
			assert.ok(finished.room.players.every((player) => Object.keys(player.scores).length === 13));
			const own = finished.room.players.find((player) => player.id === finished.playerId)!;
			assert.equal(
				(await guest.call(`/${code}/score`, 'PUT', { category: 'chance', value: null, extraYahtzee: false, version: own.version })).data
					.room.status,
				'playing',
			);
		} finally {
			ws.close();
		}
	},
	{ timeout: 20000 },
);

test('出目から計算したスコアを保存して他プレイヤーへ公開する', async () => {
	const host = client();
	const guest = client();
	const { data } = await host.call('', 'POST', { name: '計算テスト' });
	const code = data.room.code;
	await guest.call(`/${code}/join`, 'POST', { name: '相手' });
	await host.call(`/${code}/start`, 'POST', {});
	const saved = await host.call(`/${code}/score`, 'PUT', {
		category: 'threeKind',
		dice: [4, 4, 4, 2, 6],
		value: 30,
		extraYahtzee: false,
		version: 0,
	});
	assert.equal(saved.status, 200);
	assert.deepEqual(saved.data.room.players[0].scores.threeKind, { value: 20, extraYahtzee: false, dice: [4, 4, 4, 2, 6] });
	const viewed = await guest.call(`/${code}`);
	assert.deepEqual(viewed.data.room.players[0].scores.threeKind, saved.data.room.players[0].scores.threeKind);
	const invalid = await host.call(`/${code}/score`, 'PUT', {
		category: 'fourKind',
		dice: [4, 4, 4, 4, 7],
		extraYahtzee: false,
		version: 1,
	});
	assert.equal(invalid.status, 400);
	const unformed = await host.call(`/${code}/score`, 'PUT', {
		category: 'fourKind',
		dice: [4, 4, 4, 2, 6],
		extraYahtzee: false,
		version: 1,
	});
	assert.equal(unformed.status, 200);
	assert.equal(unformed.data.room.players[0].scores.fourKind?.value, 0);
	const chance = await host.call(`/${code}/score`, 'PUT', {
		category: 'chance',
		dice: [1, 2, 3, 4, 5],
		value: 30,
		extraYahtzee: false,
		version: 2,
	});
	assert.equal(chance.status, 200);
	assert.deepEqual(chance.data.room.players[0].scores.chance, { value: 15, extraYahtzee: false, dice: [1, 2, 3, 4, 5] });
	const shared = await guest.call(`/${code}`);
	assert.deepEqual(shared.data.room.players[0].scores.chance, chance.data.room.players[0].scores.chance);
	const edited = await host.call(`/${code}/score`, 'PUT', {
		category: 'chance',
		dice: [1, 2, 3, 4, 6],
		extraYahtzee: false,
		version: 3,
	});
	assert.equal(edited.status, 200);
	assert.equal(edited.data.room.players[0].scores.chance?.value, 16);
	const cleared = await host.call(`/${code}/score`, 'PUT', {
		category: 'chance',
		value: null,
		extraYahtzee: false,
		version: 4,
	});
	assert.equal(cleared.status, 200);
	assert.equal(cleared.data.room.players[0].scores.chance, undefined);
});

test('6人上限・退出・不正JSON・別Originからの更新を検証する', async () => {
	const host = client();
	const { data } = await host.call('', 'POST', { name: '人数テスト' });
	const code = data.room.code;
	const guests = Array.from({ length: 5 }, client);
	const responses = await Promise.all(guests.map((guest, index) => guest.call(`/${code}/join`, 'POST', { name: `参加者${index + 2}` })));
	assert.ok(responses.every((response) => response.status === 200));
	assert.equal((await client().call(`/${code}/join`, 'POST', { name: '7人目' })).status, 409);
	assert.equal((await guests[0].call(`/${code}/leave`, 'POST', {})).status, 200);
	assert.equal((await guests[0].call(`/${code}`)).data.playerId, null);
	assert.equal((await client().call(`/${code}/join`, 'POST', { name: '新メンバー' })).status, 200);
	const wrongOrigin = await fetch(`${base}/api/rooms/${code}/start`, {
		method: 'POST',
		headers: { Origin: 'https://other.example', Cookie: host.cookie, 'Content-Type': 'application/json' },
		body: '{}',
	});
	assert.equal(wrongOrigin.status, 403);
	const invalid = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
	assert.equal(invalid.status, 400);
	assert.equal((await host.call('/ABCDEFGH')).status, 404);
});

test(
	'出目指定のストレート条件を保存・共有し、参加や開始後の入力では変更しない',
	async () => {
		const host = client();
		assert.equal((await host.call('', 'POST', { name: '不正な条件', straightRule: 'other' })).status, 400);
		const created = await host.call('', 'POST', { name: '指定ルール', straightRule: 'fixed' });
		assert.equal(created.status, 201);
		const code = created.data.room.code;
		assert.equal(created.data.room.straightRule, 'fixed');
		const guest = client();
		assert.equal((await guest.call(`/${code}/join`, 'POST', { name: '参加者', straightRule: 'standard' })).data.room.straightRule, 'fixed');
		assert.equal((await client().call(`/${code}`)).data.room.straightRule, 'fixed');
		const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${code}/live`, { headers: { Cookie: guest.cookie } });
		const next = () =>
			new Promise<Snapshot>((resolve, reject) => {
				ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
				ws.once('error', reject);
			});
		try {
			assert.equal((await next()).room.straightRule, 'fixed');
			const started = next();
			await host.call(`/${code}/start`, 'POST', { straightRule: 'standard' });
			assert.equal((await started).room.straightRule, 'fixed');
			const scored = next();
			const small = await host.call(`/${code}/score`, 'PUT', {
				category: 'smallStraight',
				value: 30,
				extraYahtzee: false,
				version: 0,
				straightRule: 'standard',
			});
			assert.equal(small.status, 200);
			assert.equal((await scored).room.straightRule, 'fixed');
			const large = await host.call(`/${code}/score`, 'PUT', { category: 'largeStraight', value: 40, extraYahtzee: false, version: 1 });
			assert.equal(large.status, 200);
			const restored = await host.call(`/${code}`);
			assert.equal(restored.data.room.straightRule, 'fixed');
			assert.equal(restored.data.room.players[0].scores.smallStraight?.value, 30);
			assert.equal(restored.data.room.players[0].scores.largeStraight?.value, 40);
		} finally {
			ws.close();
		}
	},
	{ timeout: 10000 },
);


test('作成の連打は429になり、別IPや閲覧は引き続き利用できる', async () => {
	const sharedIp = '198.51.100.10';
	const statuses: number[] = [];
	for (let i = 0; i < 6; i++) {
		// Separate cookies on the same IP must not bypass the creation limit.
		const response = await client(sharedIp).call('', 'POST', {});
		statuses.push(response.status);
		if (response.status === 429) {
			assert.equal(response.headers.get('retry-after'), '60');
			assert.equal(response.headers.get('cache-control'), 'no-store');
		}
	}
	assert.ok(statuses.includes(429));
	assert.ok(statuses.every((status) => status === 400 || status === 429));
	assert.equal((await client('198.51.100.11').call('', 'POST', {})).status, 400);
	assert.equal((await client(sharedIp).call('/ABCDEFGH')).status, 404);
});
