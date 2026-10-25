import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	addPlayer,
	CATEGORIES,
	cleanName,
	publicRoom,
	rankings,
	recordScore,
	scoreDice,
	startGame,
	totals,
	validValues,
	type StoredRoom,
} from '../src/game.ts';

function game() {
	const room: StoredRoom = { code: 'ABCDEFGH', hostId: 'host', status: 'lobby', createdAt: '', revision: 0, players: [] };
	const host = addPlayer(room, 'secret-1', 'ホスト', 'host');
	const guest = addPlayer(room, 'secret-2', 'ゲスト', 'guest');
	return { room, host, guest };
}

test('2〜6人で開始し、ホストだけが開始できる', () => {
	const { room, host, guest } = game();
	assert.throws(() => startGame(room, guest), /ホスト/);
	for (let i = 2; i < 6; i++) addPlayer(room, `secret-${i + 1}`, `参加者${i + 1}`, `id-${i}`);
	assert.throws(() => addPlayer(room, 'seventh', '7人目', 'id-7'), /満員/);
	startGame(room, host);
	assert.throws(() => addPlayer(room, 'late', '途中参加', 'late'), /始まっています/);
	assert.equal(addPlayer(room, 'secret-1', '別名', 'other').id, host.id);
	const solo = game();
	solo.room.players.pop();
	assert.throws(() => startGame(solo.room, solo.host), /2人以上/);
});

test('未記録と0点を区別し、項目ごとの点数を検証する', () => {
	const { room, host } = game();
	assert.throws(() => recordScore(room, host, { category: 'ones', value: 0, extraYahtzee: false, version: 0 }), /始まるまで/);
	startGame(room, host);
	assert.equal(totals(host.scores).completed, 0);
	recordScore(room, host, { category: 'ones', value: 0, extraYahtzee: false, version: 0 });
	assert.equal(totals(host.scores).completed, 1);
	assert.throws(() => recordScore(room, host, { category: 'twos', value: 3, extraYahtzee: false, version: 1 }), /点数を選んで/);
	assert.throws(() => recordScore(room, host, { category: 'fullHouse', value: 24, extraYahtzee: false, version: 1 }), /点数を選んで/);
	assert.throws(() => recordScore(room, host, { category: '__proto__', value: 0, extraYahtzee: false, version: 1 }), /正しくありません/);
	assert.deepEqual(validValues('sixes'), [0, 6, 12, 18, 24, 30]);
	assert.deepEqual(validValues('yahtzee'), [0, 50]);
	recordScore(room, host, { category: 'ones', value: null, extraYahtzee: false, version: 1 });
	assert.equal(totals(host.scores).completed, 0);
});

test('上段62点ではボーナスなし、63点では35点を加算', () => {
	const scores = {
		ones: { value: 2, extraYahtzee: false },
		twos: { value: 6, extraYahtzee: false },
		threes: { value: 9, extraYahtzee: false },
		fours: { value: 12, extraYahtzee: false },
		fives: { value: 15, extraYahtzee: false },
		sixes: { value: 18, extraYahtzee: false },
	};
	assert.equal(totals(scores).upper, 62);
	assert.equal(totals(scores).upperBonus, 0);
	scores.ones.value = 3;
	assert.equal(totals(scores).total, 98);
});

test('追加ヤッツィーを各ターンに紐付け、取り消しと依存関係を検証する', () => {
	const { room, host } = game();
	startGame(room, host);
	const write = (category: string, value: number | null, extraYahtzee = false) =>
		recordScore(room, host, { category, value, extraYahtzee, version: host.version });
	assert.throws(() => write('sixes', 30, true), /追加ボーナス/);
	write('yahtzee', 0);
	assert.throws(() => write('sixes', 30, true), /追加ボーナス/);
	write('yahtzee', 50);
	write('sixes', 30, true);
	write('sixes', 30, true);
	assert.equal(totals(host.scores).extraBonus, 100);
	assert.equal(totals(host.scores).completed, 2);
	assert.throws(() => write('yahtzee', 0), /先に/);
	assert.throws(() => write('yahtzee', 50, true), /追加ボーナス/);
	write('sixes', null);
	assert.equal(totals(host.scores).extraBonus, 0);
	write('yahtzee', 0);
});

test('全員13項目で終了し、同点の順位と終了後の修正を扱う', () => {
	const { room, host, guest } = game();
	startGame(room, host);
	for (const player of [host, guest]) {
		for (const category of CATEGORIES)
			recordScore(room, player, { category: category.id, value: 0, extraYahtzee: false, version: player.version });
		assert.equal(room.status, player === host ? 'playing' : 'finished');
	}
	assert.deepEqual(
		rankings(room.players).map((entry) => entry.rank),
		[1, 1],
	);
	recordScore(room, host, { category: 'chance', value: 30, extraYahtzee: false, version: host.version });
	assert.deepEqual(
		rankings(room.players).map((entry) => entry.rank),
		[1, 2],
	);
	assert.equal(room.status, 'finished');
	recordScore(room, guest, { category: 'chance', value: null, extraYahtzee: false, version: guest.version });
	assert.equal(room.status, 'playing');
});

test('すべて最大得点と12回の追加ボーナスなら1575点', () => {
	const { room, host } = game();
	startGame(room, host);
	recordScore(room, host, { category: 'yahtzee', value: 50, extraYahtzee: false, version: 0 });
	for (const category of CATEGORIES.filter((item) => item.id !== 'yahtzee'))
		recordScore(room, host, {
			category: category.id,
			value: Math.max(...validValues(category.id)),
			extraYahtzee: true,
			version: host.version,
		});
	assert.equal(totals(host.scores).total, 1575);
	assert.equal(totals(host.scores).completed, 13);
});

test('古い版の更新を拒否し、参加者の秘密を公開しない', () => {
	const { room, host } = game();
	startGame(room, host);
	recordScore(room, host, { category: 'ones', value: 3, extraYahtzee: false, version: 0 });
	assert.throws(() => recordScore(room, host, { category: 'ones', value: 5, extraYahtzee: false, version: 0 }), /別の画面/);
	assert.equal(host.scores.ones?.value, 3);
	assert.ok(!JSON.stringify(publicRoom(room)).includes('secret-1'));
	assert.ok(!JSON.stringify(publicRoom(room)).includes('sessionHash'));
	assert.equal(cleanName('  なまえ  '), 'なまえ');
	for (const name of ['', ' ', 'あ'.repeat(21), 'a\nb', null]) assert.throws(() => cleanName(name));
});

test('スリーカード・フォーカードは成立時に5個すべてを合計し、不成立なら0点', () => {
	assert.equal(scoreDice('threeKind', [4, 4, 4, 2, 6]).value, 20);
	assert.equal(scoreDice('fourKind', [4, 4, 4, 2, 6]).value, 0);
	assert.equal(scoreDice('fourKind', [2, 5, 5, 5, 5]).value, 22);
	assert.equal(scoreDice('threeKind', [3, 2, 3, 2, 3]).value, 13);
	assert.equal(scoreDice('threeKind', [1, 2, 3, 4, 5]).value, 0);
	for (const id of ['threeKind', 'fourKind'] as const) {
		assert.equal(scoreDice(id, [1, 1, 1, 1, 1]).value, 5);
		assert.equal(scoreDice(id, [6, 6, 6, 6, 6]).value, 30);
	}
	for (const dice of [
		null,
		'44426',
		[4, 4, 4, 2],
		[4, 4, 4, 2, 6, 1],
		[4, 4, 4, 0, 6],
		[4, 4, 4, 7, 6],
		[4, 4, 4, 2.5, 6],
		[4, 4, 4, '2', 6],
		[4, 4, 4, null, 6],
		new Array(5),
	]) {
		assert.throws(() => scoreDice('threeKind', dice), /サイコロ5個/);
	}
});

test('出目付きの記録はサーバーで再計算し、出目の保存・修正・取り消しを扱う', () => {
	const { room, host } = game();
	startGame(room, host);
	const write = (input: Record<string, unknown>) =>
		recordScore(room, host, { category: 'threeKind', value: 99, extraYahtzee: false, version: host.version, ...input });
	write({ dice: [4, 4, 4, 2, 6] });
	assert.deepEqual(host.scores.threeKind, { value: 20, extraYahtzee: false, dice: [4, 4, 4, 2, 6] });
	assert.throws(() => write({ dice: [1, 2, 3] }), /サイコロ5個/);
	assert.equal(host.scores.threeKind.value, 20);
	write({ dice: [1, 2, 3, 4, 5] });
	assert.equal(host.scores.threeKind.value, 0);
	assert.throws(() => write({ category: 'ones', dice: [4, 4, 4, 2, 6] }), /この項目/);
	write({ value: null });
	assert.equal(host.scores.threeKind, undefined);
	write({ value: 23 });
	assert.deepEqual(host.scores.threeKind, { value: 23, extraYahtzee: false });
});

test('出目がある追加ヤッツィーは5個すべて同じ目であることを確認する', () => {
	const { room, host } = game();
	startGame(room, host);
	recordScore(room, host, { category: 'yahtzee', value: 50, extraYahtzee: false, version: 0 });
	assert.throws(
		() => recordScore(room, host, { category: 'fourKind', dice: [6, 6, 6, 6, 2], extraYahtzee: true, version: 1 }),
		/5個すべて/,
	);
	recordScore(room, host, { category: 'fourKind', dice: [6, 6, 6, 6, 6], extraYahtzee: true, version: 1 });
	assert.equal(host.scores.fourKind?.value, 30);
	assert.equal(totals(host.scores).total, 180);
});

test('チャンスは同じ目がなくても5個すべてを合計する', () => {
	const mixed = scoreDice('chance', [1, 2, 3, 4, 5]);
	assert.equal(mixed.value, 15);
	assert.equal(mixed.matches, true);
	assert.equal(scoreDice('chance', [1, 1, 1, 1, 1]).value, 5);
	assert.equal(scoreDice('chance', [6, 6, 6, 6, 6]).value, 30);
	assert.equal(scoreDice('chance', [2, 2, 4, 6, 6]).value, 20);
	assert.throws(() => scoreDice('chance', [1, 2, 3, 4]), /サイコロ5個/);
	assert.throws(() => scoreDice('chance', [1, 2, 3, 4, 7]), /サイコロ5個/);
});

test('チャンスの旧記録を出目付きで修正でき、取り消しと追加ボーナスも扱える', () => {
	const { room, host } = game();
	startGame(room, host);
	const write = (input: Record<string, unknown>) =>
		recordScore(room, host, {
			category: 'chance',
			extraYahtzee: false,
			version: host.version,
			...input,
		});
	write({ value: 23 });
	assert.deepEqual(host.scores.chance, { value: 23, extraYahtzee: false });
	write({ value: 30, dice: [1, 2, 3, 4, 5] });
	assert.deepEqual(host.scores.chance, { value: 15, extraYahtzee: false, dice: [1, 2, 3, 4, 5] });
	write({ dice: [1, 2, 3, 4, 6] });
	assert.equal(host.scores.chance.value, 16);
	write({ value: null });
	assert.equal(host.scores.chance, undefined);
	recordScore(room, host, { category: 'yahtzee', value: 50, extraYahtzee: false, version: host.version });
	assert.throws(() => write({ dice: [1, 2, 3, 4, 5], extraYahtzee: true }), /5個すべて/);
	write({ dice: [6, 6, 6, 6, 6], extraYahtzee: true });
	assert.equal(host.scores.chance?.value, 30);
	assert.equal(totals(host.scores).total, 180);
});
