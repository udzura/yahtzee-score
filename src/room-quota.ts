import { DurableObject } from 'cloudflare:workers';

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export class RoomCreationQuota extends DurableObject<Env> {
	protected currentTime() {
		return Date.now();
	}

	// Reserve before creating a room. Never refund an uncertain creation outcome.
	reserve() {
		const raw = this.env.DAILY_ROOM_LIMIT;
		if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
			throw new Error('DAILY_ROOM_LIMIT must be a non-negative integer');
		}
		const limit = Number(raw);
		const now = this.currentTime();
		const day = Math.floor((now + JST_OFFSET_MS) / DAY_MS);
		const resetAt = (day + 1) * DAY_MS - JST_OFFSET_MS;
		return this.ctx.storage.transactionSync(() => {
			const sql = this.ctx.storage.sql;
			sql.exec('CREATE TABLE IF NOT EXISTS daily_quota (id INTEGER PRIMARY KEY CHECK (id = 1), day INTEGER NOT NULL, used INTEGER NOT NULL)');
			const row = sql.exec<{ day: number; used: number }>('SELECT day, used FROM daily_quota WHERE id = 1').toArray()[0];
			const used = row?.day === day ? row.used : 0;
			if (used >= limit) return { allowed: false, resetAt };
			sql.exec(
				'INSERT INTO daily_quota (id, day, used) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET day = excluded.day, used = excluded.used',
				day, used + 1,
			);
			return { allowed: true, resetAt };
		});
	}
}
