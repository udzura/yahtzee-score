import { DurableObject } from 'cloudflare:workers';
import { addPlayer, cleanName, GameError, publicRoom, recordScore, startGame, type StoredRoom } from './game';

const ROOM_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

function json(body: unknown, status = 200, headers?: Record<string, string>) {
	return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	if (!request.headers.get('Content-Type')?.includes('application/json')) throw new GameError('JSONで送信してください。', 415);
	if (Number(request.headers.get('Content-Length') ?? 0) > 4096) throw new GameError('入力が長すぎます。', 413);
	const text = await request.text();
	if (text.length > 4096) throw new GameError('入力が長すぎます。', 413);
	try {
		const data = JSON.parse(text);
		if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
		return data;
	} catch {
		throw new GameError('入力内容を確認してください。');
	}
}

async function session(request: Request) {
	const oldToken = request.headers.get('Cookie')?.match(/(?:^|;\s*)yahtzee_session=([a-f0-9]{64})(?:;|$)/)?.[1];
	const token = oldToken ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
	const cookie = `yahtzee_session=${token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=31536000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
	return { hash, cookie };
}

// Preserve the starter class/binding name and the existing v1 migration.
export class MyDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	private read(): StoredRoom | undefined {
		const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id = 1').toArray()[0];
		return row ? JSON.parse(row.data) : undefined;
	}

	private snapshot(room: StoredRoom, hash: string) {
		return { room: publicRoom(room), playerId: room.players.find((player) => player.sessionHash === hash)?.id ?? null };
	}

	private save(room: StoredRoom) {
		room.revision++;
		this.ctx.storage.sql.exec(
			'INSERT INTO game (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
			JSON.stringify(room),
		);
		for (const socket of this.ctx.getWebSockets()) {
			try {
				const { playerId } = socket.deserializeAttachment() as { playerId: string };
				if (!room.players.some((player) => player.id === playerId)) {
					socket.close(1008, 'ルームから退出しました');
					continue;
				}
				socket.send(JSON.stringify({ room: publicRoom(room), playerId }));
			} catch {
				socket.close(1011, '再接続してください');
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const action = url.pathname.split('/')[4] ?? '';
			const identity = await session(request);
			const body = ['POST', 'PUT'].includes(request.method) ? await readBody(request) : {};
			// Keep read/mutate/save synchronous to serialize competing requests.
			let room = this.read();
			if (action === 'create' && request.method === 'POST') {
				if (room) throw new GameError('ルームを作り直してください。', 409);
				const id = crypto.randomUUID();
				room = {
					code: url.pathname.split('/')[3],
					hostId: id,
					status: 'lobby',
					createdAt: new Date().toISOString(),
					revision: 0,
					players: [],
				};
				addPlayer(room, identity.hash, body.name, id);
				this.save(room);
				return json(this.snapshot(room, identity.hash), 201, { 'Set-Cookie': identity.cookie });
			}
			if (!room) throw new GameError('ルームが見つかりません。コードを確認してください。', 404);
			const player = room.players.find((item) => item.sessionHash === identity.hash);
			if (!action && request.method === 'GET') return json(this.snapshot(room, identity.hash));
			if (action === 'join' && request.method === 'POST') {
				addPlayer(room, identity.hash, body.name, crypto.randomUUID());
				this.save(room);
				return json(this.snapshot(room, identity.hash), 200, { 'Set-Cookie': identity.cookie });
			}
			if (!player) throw new GameError('先に名前を入力して、ルームに参加してください。', 403);
			if (action === 'live' && request.method === 'GET') {
				if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new GameError('WebSocketで接続してください。', 426);
				const { 0: client, 1: server } = new WebSocketPair();
				this.ctx.acceptWebSocket(server);
				server.serializeAttachment({ playerId: player.id });
				server.send(JSON.stringify(this.snapshot(room, identity.hash)));
				return new Response(null, { status: 101, webSocket: client });
			}
			if (action === 'start' && request.method === 'POST') startGame(room, player);
			else if (action === 'score' && request.method === 'PUT') recordScore(room, player, body);
			else if (action === 'name' && request.method === 'PUT') player.name = cleanName(body.name);
			else if (action === 'leave' && request.method === 'POST') {
				if (room.status !== 'lobby') throw new GameError('開始後は退出できません。', 409);
				if (room.hostId === player.id) throw new GameError('ホストはルームに残ってください。', 409);
				room.players = room.players.filter((item) => item.id !== player.id);
			} else throw new GameError('ページが見つかりません。', 404);
			this.save(room);
			return json(this.snapshot(room, identity.hash));
		} catch (error) {
			if (error instanceof GameError) return json({ error: error.message }, error.status);
			console.error(error);
			return json({ error: '保存できませんでした。接続を確認して、もう一度お試しください。' }, 500);
		}
	}

	webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer) {
		socket.close(1008, 'この接続は同期専用です');
	}
	webSocketError(socket: WebSocket) {
		socket.close(1011, '再接続してください');
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
		if (
			(request.method !== 'GET' || request.headers.get('Upgrade')) &&
			request.headers.get('Origin') &&
			request.headers.get('Origin') !== url.origin
		)
			return json({ error: '同じサイトから操作してください。' }, 403);
		if (url.pathname === '/api/rooms' && request.method === 'POST') {
			const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
			const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => alphabet[byte % alphabet.length]).join('');
			url.pathname = `/api/rooms/${code}/create`;
			return env.MY_DURABLE_OBJECT.getByName(code).fetch(new Request(url, request));
		}
		const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|live|start|score|name|leave))?$/);
		if (!match || !ROOM_CODE.test(match[1])) return json({ error: 'ルームコードは8文字の英数字で入力してください。' }, 404);
		return env.MY_DURABLE_OBJECT.getByName(match[1]).fetch(request);
	},
} satisfies ExportedHandler<Env>;
