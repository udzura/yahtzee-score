export const CATEGORIES = [
	{ id: 'ones', name: 'エース', english: 'Aces', hint: '1の目の合計', face: 1, section: 'upper' },
	{ id: 'twos', name: 'デュース', english: 'Twos', hint: '2の目の合計', face: 2, section: 'upper' },
	{ id: 'threes', name: 'トレイ', english: 'Threes', hint: '3の目の合計', face: 3, section: 'upper' },
	{ id: 'fours', name: 'フォー', english: 'Fours', hint: '4の目の合計', face: 4, section: 'upper' },
	{ id: 'fives', name: 'ファイブ', english: 'Fives', hint: '5の目の合計', face: 5, section: 'upper' },
	{ id: 'sixes', name: 'シックス', english: 'Sixes', hint: '6の目の合計', face: 6, section: 'upper' },
	{ id: 'threeKind', name: 'スリーカード', english: '3 of a kind', hint: '同じ目が3個以上 → 5個すべての合計', face: 0, section: 'lower' },
	{ id: 'fourKind', name: 'フォーカード', english: '4 of a kind', hint: '同じ目が4個以上 → 5個すべての合計', face: 0, section: 'lower' },
	{ id: 'fullHouse', name: 'フルハウス', english: 'Full house', hint: '同じ目3個 ＋ 別の同じ目2個', face: 0, section: 'lower', fixed: 25 },
	{
		id: 'smallStraight',
		name: 'スモールストレート',
		english: 'Small straight',
		hint: '4つの連続した目',
		face: 0,
		section: 'lower',
		fixed: 30,
	},
	{
		id: 'largeStraight',
		name: 'ラージストレート',
		english: 'Large straight',
		hint: '5つの連続した目',
		face: 0,
		section: 'lower',
		fixed: 40,
	},
	{ id: 'yahtzee', name: 'ヤッツィー', english: 'Yahtzee', hint: '5個すべて同じ目', face: 0, section: 'lower', fixed: 50 },
	{ id: 'chance', name: 'チャンス', english: 'Chance', hint: 'どんな組み合わせでも、5個すべての合計', face: 0, section: 'lower' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];
export type ScoreEntry = { value: number; extraYahtzee: boolean; dice?: number[] };
export type Scores = Partial<Record<CategoryId, ScoreEntry>>;
export type Player = { id: string; name: string; scores: Scores; version: number };
export type PrivatePlayer = Player & { sessionHash: string };
export type Room = {
	code: string;
	hostId: string;
	status: 'lobby' | 'playing' | 'finished';
	createdAt: string;
	revision: number;
	players: Player[];
};
export type StoredRoom = Omit<Room, 'players'> & { players: PrivatePlayer[] };
export type Snapshot = { room: Room; playerId: string | null };

export class GameError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export function cleanName(value: unknown): string {
	if (typeof value !== 'string') throw new GameError('名前を入力してください。');
	const name = value.trim();
	if (!name || [...name].length > 20 || /[\u0000-\u001f\u007f]/u.test(name)) throw new GameError('名前は1〜20文字で入力してください。');
	return name;
}

export function totals(scores: Scores) {
	let upper = 0,
		lower = 0,
		extraBonus = 0,
		completed = 0;
	for (const category of CATEGORIES) {
		const entry = scores[category.id];
		if (!entry) continue;
		completed++;
		if (category.section === 'upper') upper += entry.value;
		else lower += entry.value;
		if (entry.extraYahtzee) extraBonus += 100;
	}
	const upperBonus = upper >= 63 ? 35 : 0;
	return { upper, lower, upperBonus, extraBonus, completed, total: upper + lower + upperBonus + extraBonus };
}

export function validValues(id: CategoryId): number[] {
	const category = CATEGORIES.find((item) => item.id === id);
	if (!category) return [];
	if (category.face) return Array.from({ length: 6 }, (_, i) => i * category.face);
	if ('fixed' in category) return [0, category.fixed];
	return [0, ...Array.from({ length: 26 }, (_, i) => i + 5)];
}

export function publicRoom(room: StoredRoom): Room {
	return { ...room, players: room.players.map(({ sessionHash: _secret, ...player }) => player) };
}

export function scoreKindDice(id: 'threeKind' | 'fourKind', input: unknown) {
	if (!Array.isArray(input) || input.length !== 5 || !Array.from(input).every((face) => Number.isInteger(face) && face >= 1 && face <= 6)) {
		throw new GameError('サイコロ5個の出目を、それぞれ1〜6で入力してください。');
	}
	const dice = [...input] as number[];
	const total = dice.reduce((sum, face) => sum + face, 0);
	const required = id === 'threeKind' ? 3 : 4;
	const matches = dice.some((face) => dice.filter((other) => other === face).length >= required);
	return { dice, total, matches, value: matches ? total : 0 };
}

export function addPlayer(room: StoredRoom, sessionHash: string, name: unknown, id: string): PrivatePlayer {
	const existing = room.players.find((player) => player.sessionHash === sessionHash);
	if (existing) return existing;
	if (room.status !== 'lobby') throw new GameError('このゲームはすでに始まっています。', 409);
	if (room.players.length >= 6) throw new GameError('ルームは満員です（最大6人）。', 409);
	const player: PrivatePlayer = { id, name: cleanName(name), sessionHash, scores: {}, version: 0 };
	room.players.push(player);
	return player;
}

export function startGame(room: StoredRoom, player: PrivatePlayer) {
	if (room.hostId !== player.id) throw new GameError('ゲームを始められるのはホストだけです。', 403);
	if (room.status !== 'lobby') throw new GameError('ゲームはすでに始まっています。', 409);
	if (room.players.length < 2) throw new GameError('2人以上の参加を待ってください。', 409);
	room.status = 'playing';
}

export function recordScore(room: StoredRoom, player: PrivatePlayer, input: Record<string, unknown>) {
	if (room.status === 'lobby') throw new GameError('ゲームが始まるまでお待ちください。', 409);
	if (input.version !== player.version)
		throw new GameError('別の画面でスコアが更新されました。最新の内容を確認して、もう一度記録してください。', 409);
	const category = CATEGORIES.find((item) => item.id === input.category);
	if (!category) throw new GameError('得点項目が正しくありません。');
	if (typeof input.extraYahtzee !== 'boolean') throw new GameError('ボーナスの指定が正しくありません。');
	const { extraYahtzee } = input;
	let value = input.value;
	let dice: number[] | undefined;
	if (value !== null && input.dice !== undefined) {
		if (category.id !== 'threeKind' && category.id !== 'fourKind') throw new GameError('この項目では出目による計算は使えません。');
		const calculated = scoreKindDice(category.id, input.dice);
		value = calculated.value;
		dice = calculated.dice;
	}
	if (value !== null && (typeof value !== 'number' || !validValues(category.id).includes(value)))
		throw new GameError('この項目に記録できる点数を選んでください。');
	if (extraYahtzee && (value === null || category.id === 'yahtzee' || player.scores.yahtzee?.value !== 50))
		throw new GameError('追加ボーナスは、ヤッツィーに50点を記録したあとの別のターンで付けられます。');
	if (extraYahtzee && dice && new Set(dice).size !== 1) throw new GameError('追加ヤッツィーボーナスには5個すべて同じ目が必要です。');
	if (category.id === 'yahtzee' && value !== 50 && Object.values(player.scores).some((entry) => entry.extraYahtzee))
		throw new GameError('先に他の項目の追加ヤッツィーボーナスを外してください。');
	if (value === null) delete player.scores[category.id];
	else player.scores[category.id] = { value: value as number, extraYahtzee, ...(dice ? { dice } : {}) };
	player.version++;
	room.status = room.players.every((item) => totals(item.scores).completed === 13) ? 'finished' : 'playing';
}

export function rankings(players: Player[]) {
	const sorted = players.map((player) => ({ player, ...totals(player.scores) })).sort((a, b) => b.total - a.total);
	return sorted.map((entry) => ({ ...entry, rank: sorted.findIndex((item) => item.total === entry.total) + 1 }));
}
