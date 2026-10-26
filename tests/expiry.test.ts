import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { WebSocket } from 'ws';
import type { Snapshot } from '../src/game.ts';

const RETENTION = 7 * 24 * 60 * 60 * 1000;
let mf: Miniflare;

before(async () => {
	const bundled = await build({
		stdin: {
			resolveDir: process.cwd(),
			contents: `
				import worker, { MyDurableObject } from './src/index.ts';
				export { RoomCreationQuota } from './src/room-quota.ts';
				export default {
					async fetch(request, env) {
						const path = new URL(request.url).pathname.split('/');
						if (path[1] !== '__test') return worker.fetch(request, env);
						const stub = env.MY_DURABLE_OBJECT.getByName(path[2]);
						const result = await stub[path[3]](...await request.json());
						return Response.json(result ?? null);
					}
				};
				export class TestRoom extends MyDurableObject {
					async inspect() {
						const tables = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game'").toArray();
						const room = tables.length ? JSON.parse(this.ctx.storage.sql.exec('SELECT data FROM game WHERE id = 1').one().data) : null;
						return { room, alarm: await this.ctx.storage.getAlarm(), tables, sockets: this.ctx.getWebSockets().length };
					}
					async setExpiry(expiresAt, schedule = false) {
						this.ctx.storage.sql.exec("UPDATE game SET data = json_set(data, '$.expiresAt', ?) WHERE id = 1", expiresAt);
						if (schedule) await this.ctx.storage.setAlarm(expiresAt);
					}
					async seedLegacy(room) {
						this.ctx.storage.sql.exec('CREATE TABLE game (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
						this.ctx.storage.sql.exec('INSERT INTO game VALUES (1, ?)', JSON.stringify(room));
					}
					async runAlarm() { await this.alarm(); }
				}
			`,
		},
		bundle: true,
		format: 'esm',
		external: ['cloudflare:workers'],
		write: false,
	});
	mf = new Miniflare({
		workers: [
			{
				config: {
					name: 'expiry-tests',
					compatibilityDate: '2026-10-19',
					manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundled.outputFiles[0].text } } },
					env: {
						DAILY_ROOM_LIMIT: { type: 'json', value: '100' },
						ROOM_CREATION_QUOTA: { type: 'durable-object', worker: 'expiry-tests', exportName: 'RoomCreationQuota' },
						MY_DURABLE_OBJECT: { type: 'durable-object', worker: 'expiry-tests', exportName: 'TestRoom' },
						API_RATE_LIMITER: { type: 'rate-limit', namespace: '1', simple: { limit: 300, period: 60 } },
						CREATE_RATE_LIMITER: { type: 'rate-limit', namespace: '2', simple: { limit: 5, period: 60 } },
						WRITE_RATE_LIMITER: { type: 'rate-limit', namespace: '3', simple: { limit: 120, period: 60 } },
						LIVE_RATE_LIMITER: { type: 'rate-limit', namespace: '4', simple: { limit: 60, period: 60 } },
					},
					exports: { TestRoom: { type: 'durable-object', storage: 'sqlite' }, RoomCreationQuota: { type: 'durable-object', storage: 'sqlite' } },
				},
			},
		],
	});
	await mf.ready;
});
after(async () => mf?.dispose());

async function roomStub(code: string) {
	const call = async (method: string, ...args: unknown[]) => {
		const response = await mf.dispatchFetch(`http://localhost/__test/${code}/${method}`, { method: 'POST', body: JSON.stringify(args) });
		assert.equal(response.status, 200, await response.clone().text());
		return response.json() as any;
	};
	return {
		inspect: () => call('inspect'),
		setExpiry: (expiresAt: number, schedule = false) => call('setExpiry', expiresAt, schedule),
		seedLegacy: (room: unknown) => call('seedLegacy', room),
		runAlarm: () => call('runAlarm'),
	};
}

function client() {
	let cookie = '';
	return {
		async call(path = '', method = 'GET', body?: unknown) {
			const response = await mf.dispatchFetch(`http://localhost/api/rooms${path}`, {
				method,
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
			return { status: response.status, data: (await response.json()) as Snapshot & { error?: string } };
		},
		async live(code: string) {
			const url = new URL(`/api/rooms/${code}/live`, await mf.ready);
			url.protocol = 'ws:';
			// Bound the local proxy's TCP close wait after receiving a Close frame.
			const socket = new WebSocket(url, { headers: { Cookie: cookie }, closeTimeout: 500 });
			await new Promise<void>((resolve, reject) => {
				socket.once('open', resolve);
				socket.once('error', reject);
			});
			return socket;
		},
	};
}

test('作成時に7日後のAlarmを設定し、閲覧では延長せず更新で延長する', async () => {
	const host = client();
	const before = Date.now();
	const created = await host.call('', 'POST', { name: '期限テスト' });
	assert.equal(created.status, 201);
	assert.ok(created.data.room.expiresAt! >= before + RETENTION);
	assert.ok(created.data.room.expiresAt! <= Date.now() + RETENTION);
	const code = created.data.room.code;
	const stub = await roomStub(code);
	assert.equal((await stub.inspect()).alarm, created.data.room.expiresAt);
	const deadline = Date.now() + 60_000;
	await stub.setExpiry(deadline, true);
	assert.equal((await host.call(`/${code}`)).data.room.expiresAt, deadline);
	assert.equal((await stub.inspect()).alarm, deadline);
	const invalid = await host.call(`/${code}/name`, 'PUT', { name: '' });
	assert.equal(invalid.status, 400);
	assert.equal((await stub.inspect()).alarm, deadline);
	const updated = await host.call(`/${code}/name`, 'PUT', { name: '変更後' });
	assert.ok(updated.data.room.expiresAt! > deadline);
	await stub.runAlarm();
	const retained = await stub.inspect();
	assert.equal(retained.room.players[0].name, '変更後');
	assert.equal(retained.alarm, updated.data.room.expiresAt);
});

test('実際のAlarmで保存領域を削除し、WebSocketを閉じ、再アクセスでも復元しない', async () => {
	const host = client();
	const { data } = await host.call('', 'POST', { name: '削除テスト' });
	const code = data.room.code;
	const stub = await roomStub(code);
	const socket = await host.live(code);
	assert.equal((await stub.inspect()).sockets, 1);
	const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code), { once: true }));
	await stub.setExpiry(Date.now() + 200, true);
	const closeCode = await Promise.race([closed, delay(5000).then(() => 'timeout')]);
	const alarmState = await stub.inspect();
	if (closeCode === 'timeout') socket.close();
	assert.equal(closeCode, 4004, JSON.stringify(alarmState));
	for (let i = 0; i < 2; i++) {
		const missing = await host.call(`/${code}`);
		assert.equal(missing.status, 404);
		assert.match(missing.data.error!, /保存期限/);
	}
	assert.equal((await host.call(`/${code}/name`, 'PUT', { name: '復活しない' })).status, 404);
	const empty = await stub.inspect();
	assert.equal(empty.room, null);
	assert.equal(empty.alarm, null);
	assert.deepEqual(empty.tables, []);
});

test('Alarmが遅れていても期限を過ぎたHTTPリクエストは更新できない', async () => {
	const host = client();
	const { data } = await host.call('', 'POST', { name: '期限後の更新' });
	const stub = await roomStub(data.room.code);
	await stub.setExpiry(Date.now() - 1);
	const expired = await host.call(`/${data.room.code}/name`, 'PUT', { name: '延長しない' });
	assert.equal(expired.status, 404);
	assert.match(expired.data.error!, /保存期限/);
	assert.equal((await stub.inspect()).room, null);
});

test('既存ルームは初回アクセスで期限を設定し、再起動で延長しない', async () => {
	const code = 'LEGACYAB';
	const stub = await roomStub(code);
	await stub.seedLegacy({ code, hostId: 'host', status: 'finished', createdAt: '2020-01-01T00:00:00.000Z', revision: 1, players: [] });
	await mf.unsafeEvictDurableObject('expiry-tests', 'TestRoom', { name: code });
	const before = Date.now();
	const first = await client().call(`/${code}`);
	assert.equal(first.status, 200);
	assert.equal(first.data.room.status, 'finished');
	assert.ok(first.data.room.expiresAt! >= before + RETENTION);
	const deadline = first.data.room.expiresAt;
	await mf.unsafeEvictDurableObject('expiry-tests', 'TestRoom', { name: code });
	const second = await client().call(`/${code}`);
	assert.equal(second.data.room.expiresAt, deadline);
	assert.equal((await stub.inspect()).alarm, deadline);
});
