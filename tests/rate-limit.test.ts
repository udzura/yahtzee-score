import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitApiRequest } from '../src/rate-limit.ts';

function fixture(block = '', fail = false) {
	const calls: { name: string; key: string }[] = [];
	const binding = (name: string) => ({
		async limit({ key }: { key: string }) {
			calls.push({ name, key });
			if (fail) throw new Error('unavailable');
			return { success: name !== block };
		},
	});
	return {
		calls,
		env: {
			API_RATE_LIMITER: binding('api'),
			CREATE_RATE_LIMITER: binding('create'),
			WRITE_RATE_LIMITER: binding('write'),
			LIVE_RATE_LIMITER: binding('live'),
		},
	};
}
function request(path: string, method = 'GET', headers: Record<string, string> = {}) {
	return new Request('https://example.com' + path, { method, headers });
}

test('all room codes share an IP bucket; cookies and forwarded headers cannot reset it', async () => {
	const { env, calls } = fixture();
	for (const path of ['/api/rooms/ABCDEFGH', '/api/rooms/ZZZZZZZZ', '/api/unknown']) {
		await limitApiRequest(request(path, 'GET', { 'CF-Connecting-IP': '192.0.2.1', Cookie: path, 'X-Forwarded-For': path }), env);
	}
	assert.equal(calls.length, 3);
	assert.equal(new Set(calls.map((call) => call.key)).size, 1);
	await limitApiRequest(request('/api/rooms/ABCDEFGH', 'GET', { 'CF-Connecting-IP': '192.0.2.2' }), env);
	assert.notEqual(calls[0].key, calls[3].key);
});

test('creation, writes and WebSocket handshakes have separate additional limits', async () => {
	for (const [path, method, expected] of [
		['/api/rooms', 'POST', 'create'],
		['/api/rooms/ABCDEFGH/join', 'POST', 'write'],
		['/api/rooms/ABCDEFGH/score', 'PUT', 'write'],
		['/api/rooms/ABCDEFGH/live', 'GET', 'live'],
	]) {
		const { env, calls } = fixture();
		assert.equal(await limitApiRequest(request(path, method), env), undefined);
		assert.deepEqual(calls.map((call) => call.name), ['api', expected]);
	}
});

test('rejection stops checking and returns non-cacheable 429 with retry guidance', async () => {
	for (const block of ['api', 'create']) {
		const { env, calls } = fixture(block);
		const result = await limitApiRequest(request('/api/rooms', 'POST'), env);
		assert.equal(result?.status, 429);
		assert.equal(result.headers.get('Retry-After'), '60');
		assert.equal(result.headers.get('Cache-Control'), 'no-store');
		assert.match((await result.json()).error, /1分/);
		assert.equal(calls.length, block === 'api' ? 1 : 2);
	}
});

test('missing IP is limited too; limiter failures fail closed', async () => {
	const { env, calls } = fixture('api');
	assert.equal((await limitApiRequest(request('/api/rooms', 'POST'), env))?.status, 429);
	assert.match(calls[0].key, /unknown$/);
	const unavailable = fixture('', true);
	assert.equal((await limitApiRequest(request('/api/rooms', 'POST'), unavailable.env))?.status, 503);
});
