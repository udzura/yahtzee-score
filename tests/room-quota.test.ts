import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

async function setup(limit = '2') {
	const bundle = await build({
		stdin: { resolveDir: process.cwd(), contents: `
			import worker, { MyDurableObject } from './src/index.ts';
			import { RoomCreationQuota } from './src/room-quota.ts';
			export { MyDurableObject };
			export class TestQuota extends RoomCreationQuota {
				currentTime() { return this.ctx.storage.kv.get('clock') ?? Date.now(); }
				setClock(now) { this.ctx.storage.kv.put('clock', now); }
				inspect() {
					return this.ctx.storage.sql.exec('SELECT day, used FROM daily_quota').toArray();
				}
			}
			export default {
				async fetch(request, env) {
					const path = new URL(request.url).pathname;
					const stub = env.ROOM_CREATION_QUOTA.getByName('global-room-creation');
					if (path === '/__clock') { await stub.setClock(Number(await request.text())); return new Response('ok'); }
					if (path === '/__inspect') return Response.json(await stub.inspect());
					return worker.fetch(request, env);
				}
			};
		` },
		bundle: true, format: 'esm', external: ['cloudflare:workers'], write: false,
	});
	const mf = new Miniflare({ workers: [{ config: {
		name: 'quota-tests', compatibilityDate: '2026-10-19',
		manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
		env: {
			DAILY_ROOM_LIMIT: { type: 'json', value: limit },
			ROOM_CREATION_QUOTA: { type: 'durable-object', worker: 'quota-tests', exportName: 'TestQuota' },
			MY_DURABLE_OBJECT: { type: 'durable-object', worker: 'quota-tests', exportName: 'MyDurableObject' },
			API_RATE_LIMITER: { type: 'rate-limit', namespace: '1', simple: { limit: 300, period: 60 } },
			CREATE_RATE_LIMITER: { type: 'rate-limit', namespace: '2', simple: { limit: 5, period: 60 } },
			WRITE_RATE_LIMITER: { type: 'rate-limit', namespace: '3', simple: { limit: 120, period: 60 } },
			LIVE_RATE_LIMITER: { type: 'rate-limit', namespace: '4', simple: { limit: 60, period: 60 } },
		},
		exports: {
			TestQuota: { type: 'durable-object', storage: 'sqlite' },
			MyDurableObject: { type: 'durable-object', storage: 'sqlite' },
		},
	} }] });
	let ip = 0;
	const create = (body: unknown = { name: 'テスト' }) => mf.dispatchFetch('https://example.com/api/rooms', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.' + ++ip },
		body: JSON.stringify(body),
	});
	const clock = (iso: string) => mf.dispatchFetch('https://example.com/__clock', { method: 'POST', body: String(Date.parse(iso)) });
	return { mf, create, clock };
}

test('different IPs share a strict quota under concurrency; existing rooms still work', async () => {
	const { mf, create } = await setup();
	try {
		assert.equal((await create({ name: '' })).status, 400);
		assert.equal((await create({ name: '名前', straightRule: 'invalid' })).status, 400);
		const responses = await Promise.all(Array.from({ length: 20 }, () => create()));
		assert.equal(responses.filter((r) => r.status === 201).length, 2);
		assert.equal(responses.filter((r) => r.status === 429).length, 18);
		const rejected = responses.find((r) => r.status === 429)!;
		assert.match((await rejected.json()).error, /午前0時/);
		assert.ok(Number(rejected.headers.get('Retry-After')) > 0);
		assert.equal(rejected.headers.get('Cache-Control'), 'no-store');
		const created = responses.find((r) => r.status === 201)!;
		const snapshot = await created.json();
		const code = snapshot.room.code;
		assert.equal((await mf.dispatchFetch('https://example.com/api/rooms/' + code)).status, 200);
		const renamed = await mf.dispatchFetch('https://example.com/api/rooms/' + code + '/name', {
			method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: created.headers.get('Set-Cookie')!.split(';')[0] },
			body: JSON.stringify({ name: '変更後' }),
		});
		assert.equal(renamed.status, 200);
		const rows = await (await mf.dispatchFetch('https://example.com/__inspect')).json();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].used, 2);
	} finally { await mf.dispose(); }
});

test('quota survives eviction and resets exactly at midnight JST without accumulating rows', async () => {
	const { mf, create, clock } = await setup('1');
	try {
		await clock('2026-10-26T14:59:59.000Z');
		assert.equal((await create()).status, 201);
		assert.equal((await create()).status, 429);
		await mf.unsafeEvictDurableObject('quota-tests', 'TestQuota', { name: 'global-room-creation' });
		assert.equal((await create()).status, 429);
		await clock('2026-10-26T15:00:00.000Z');
		assert.equal((await create()).status, 201);
		assert.equal((await create()).status, 429);
		const rows = await (await mf.dispatchFetch('https://example.com/__inspect')).json();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].used, 1);
	} finally { await mf.dispose(); }
});

test('zero disables creation and invalid settings fail closed', async () => {
	for (const [limit, status] of [['0', 429], ['invalid', 503], ['-1', 503]]) {
		const { mf, create } = await setup(limit);
		try { assert.equal((await create()).status, status); }
		finally { await mf.dispose(); }
	}
});
