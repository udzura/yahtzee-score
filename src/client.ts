import { toCanvas } from 'qrcode';
import { CATEGORIES, rankings, scoreKindDice, totals, validValues, type CategoryId, type Player, type Snapshot } from './game';

const app = document.querySelector<HTMLElement>('#app')!;
const modal = document.querySelector<HTMLDialogElement>('#modal')!;
let current: Snapshot | null = null;
let activePlayerId: string | null = null;
let showResults = true;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let reconnectDelay = 1000;
let lastPong = 0;
let connection = 'connecting';
let toastTimer: ReturnType<typeof setTimeout>;

function escape(value: unknown) {
	return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
function stored(key: string) {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}
function store(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* Cookie-based sessions still work. */
	}
}
function toast(message: string) {
	const element = document.querySelector<HTMLElement>('#toast')!;
	element.textContent = message;
	element.classList.add('visible');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => element.classList.remove('visible'), 3500);
}
function errorText(error: unknown) {
	return error instanceof Error ? error.message : '接続を確認して、もう一度お試しください。';
}

async function api(path: string, method = 'GET', body?: unknown): Promise<Snapshot> {
	let response: Response;
	try {
		response = await fetch(`/api/rooms${path}`, {
			method,
			headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(12000),
		});
	} catch {
		throw new Error('通信できませんでした。接続を確認して、もう一度お試しください。');
	}
	const result = (await response.json()) as Snapshot & { error?: string };
	if (!response.ok) throw new Error(result.error ?? '操作できませんでした。もう一度お試しください。');
	return result;
}

function accept(snapshot: Snapshot) {
	if (current?.room.code === snapshot.room.code && current.room.revision > snapshot.room.revision) return;
	current = snapshot;
	if (!snapshot.room.players.some((player) => player.id === activePlayerId))
		activePlayerId = snapshot.playerId ?? snapshot.room.players[0]?.id;
	if (snapshot.playerId) store('yahtzee.lastRoom', snapshot.room.code);
	render();
}
function enter(snapshot: Snapshot) {
	stopConnection();
	current = null;
	activePlayerId = snapshot.playerId;
	showResults = true;
	history.replaceState(null, '', `/?room=${snapshot.room.code}`);
	accept(snapshot);
	if (snapshot.playerId) connect();
}
function stopConnection() {
	clearTimeout(reconnectTimer);
	clearInterval(heartbeatTimer);
	if (socket) {
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		socket.close();
		socket = null;
	}
}
function connect() {
	if (!current?.playerId) return;
	stopConnection();
	setConnection(navigator.onLine ? 'connecting' : 'offline');
	const code = current.room.code;
	const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${code}/live`);
	socket = ws;
	ws.onopen = () => {
		reconnectDelay = 1000;
		lastPong = Date.now();
		setConnection('online');
		heartbeatTimer = setInterval(() => {
			if (Date.now() - lastPong > 65000) {
				ws.close();
				return;
			}
			if (ws.readyState === WebSocket.OPEN) ws.send('ping');
		}, 25000);
	};
	ws.onmessage = (event) => {
		lastPong = Date.now();
		if (event.data === 'pong') return;
		try {
			accept(JSON.parse(event.data) as Snapshot);
		} catch {
			toast('同期データを読み込めませんでした。再接続します。');
			ws.close();
		}
	};
	ws.onclose = () => {
		clearInterval(heartbeatTimer);
		setConnection(navigator.onLine ? 'connecting' : 'offline');
		reconnectTimer = setTimeout(connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 15000);
	};
	ws.onerror = () => ws.close();
}
function setConnection(state: string) {
	connection = state;
	for (const element of document.querySelectorAll<HTMLElement>('.sync-state')) {
		element.dataset.state = state;
		element.textContent = state === 'online' ? '全員と同期中' : state === 'offline' ? 'オフライン・再接続を待機中' : '同期に再接続中…';
	}
}

function die(face: number, className = '') {
	return `<span class="die face-${face} ${className}" aria-hidden="true">${Array.from({ length: 9 }, (_, index) => `<i class="pip p${index + 1}"></i>`).join('')}</span>`;
}
function avatar(player: Player, index: number, large = false) {
	return `<span class="avatar color-${index % 6}${large ? ' avatar-large' : ''}" aria-hidden="true">${escape([...player.name][0])}</span>`;
}

function home(code = '', message = '') {
	const isInvite = Boolean(code);
	app.innerHTML = `<section class="home-layout">
		<div class="home-intro"><p class="eyebrow"><span class="tiny-line"></span> A LITTLE LESS COUNTING, A LOT MORE PLAYING.</p>
		<h1>サイコロは、<br>テーブルに。<br><span>スコアは、ここに。</span></h1>
		<p class="intro-copy">お気に入りのサイコロと、いつもの仲間。<br>面倒な計算はスコア帳にまかせて、<br>次のひと振りを楽しもう。</p>
		<div class="tabletop" aria-hidden="true"><div class="tabletop-ring"></div>${die(5, 'hero-die die-one')}${die(3, 'hero-die die-two')}${die(6, 'hero-die die-three')}<span class="tabletop-note">Let the good times roll.</span></div>
		<div class="home-tags"><span>2〜6人で</span><span>リアルタイム同期</span><span>登録不要</span></div></div>
		<div class="entry-card"><div class="card-topline"><span class="eyebrow">LET’S GET TOGETHER</span>${die(5)}</div>
		<h2>${isInvite ? 'スコア帳に招待されました' : 'さあ、みんなで遊ぼう。'}</h2><p class="muted">${isInvite ? `ルーム <strong>${escape(code)}</strong> に名前を入力して参加。` : 'ひとりがルームをつくって、みんなを招待。'}</p>
		<div class="mode-tabs" role="tablist" aria-label="参加方法"><button role="tab" id="create-tab" aria-selected="${!isInvite}" aria-controls="entry-panel">ルームをつくる</button><button role="tab" id="join-tab" aria-selected="${isInvite}" aria-controls="entry-panel">ルームに参加</button></div>
		<form id="entry-form"><div id="entry-panel" role="tabpanel"><label for="player-name">あなたの名前<span>20文字まで</span></label><input id="player-name" name="name" autocomplete="nickname" maxlength="40" placeholder="例：たろう" value="${escape(stored('yahtzee.name'))}" required>
		<div id="code-field" ${isInvite ? '' : 'hidden'}><label for="room-code">ルームコード</label><input id="room-code" name="code" class="code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="8文字のルームコード" value="${escape(code)}"></div>
		<p class="form-error" id="entry-error" role="alert">${escape(message)}</p><button class="button button-primary" id="entry-submit" type="submit">${isInvite ? 'ルームに参加する' : '新しいルームをつくる'}<span aria-hidden="true">↗</span></button></div></form>
		<p class="entry-note">アカウント登録は不要です。<br>サイコロは実物をご用意ください。</p>
		${!isInvite && stored('yahtzee.lastRoom') ? `<button class="resume-button" id="resume-room">前のスコア帳をひらく <span>↗</span></button>` : ''}</div>
	</section><section class="how-it-works" aria-label="使い方"><div><span>01</span><p><strong>みんなで集まる</strong><small>URLかルームコードを共有。</small></p></div><div><span>02</span><p><strong>振ったら、記録</strong><small>役をタップして点数を選ぶだけ。</small></p></div><div><span>03</span><p><strong>最後まで、楽しむ</strong><small>13ターンの合計と順位は自動計算。</small></p></div></section>`;
	let mode: 'create' | 'join' = isInvite ? 'join' : 'create';
	const setMode = (next: typeof mode) => {
		mode = next;
		document.querySelector('#create-tab')!.setAttribute('aria-selected', String(mode === 'create'));
		document.querySelector('#join-tab')!.setAttribute('aria-selected', String(mode === 'join'));
		document.querySelector<HTMLElement>('#code-field')!.hidden = mode !== 'join';
		document.querySelector<HTMLInputElement>('#room-code')!.required = mode === 'join';
		document.querySelector('#entry-submit')!.innerHTML =
			`${mode === 'join' ? 'ルームに参加する' : '新しいルームをつくる'}<span aria-hidden="true">↗</span>`;
	};
	document.querySelector('#create-tab')!.addEventListener('click', () => setMode('create'));
	document.querySelector('#join-tab')!.addEventListener('click', () => setMode('join'));
	setMode(mode);
	document.querySelector('#entry-form')!.addEventListener('submit', async (event) => {
		event.preventDefault();
		const button = document.querySelector<HTMLButtonElement>('#entry-submit')!;
		const name = document.querySelector<HTMLInputElement>('#player-name')!.value.trim();
		const roomCode = document.querySelector<HTMLInputElement>('#room-code')!.value.replace(/[\s-]/g, '').toUpperCase();
		button.disabled = true;
		document.querySelector('#entry-error')!.textContent = '';
		try {
			if (mode === 'join' && !/^[A-HJ-NP-Z2-9]{8}$/.test(roomCode)) throw new Error('ルームコードを8文字の英数字で入力してください。');
			const snapshot = await api(mode === 'create' ? '' : `/${roomCode}/join`, 'POST', { name });
			store('yahtzee.name', name);
			enter(snapshot);
		} catch (error) {
			document.querySelector('#entry-error')!.textContent = errorText(error);
			button.disabled = false;
		}
	});
	document.querySelector('#resume-room')?.addEventListener('click', () => void loadRoom(stored('yahtzee.lastRoom')));
}

function roomBar() {
	return `<div class="room-bar"><div><span class="eyebrow">TABLE NO.</span><button class="room-code-button" data-action="share" aria-label="招待リンクを表示">${current!.room.code}<span aria-hidden="true">↗</span></button></div><span class="sync-state" data-state="${connection}">${connection === 'online' ? '全員と同期中' : '同期に再接続中…'}</span></div>`;
}
function render() {
	if (!current) {
		home();
		return;
	}
	if (!current.playerId) {
		home(
			current.room.code,
			current.room.status !== 'lobby' ? 'このゲームはすでに始まっています。参加したときと同じブラウザで開いてください。' : '',
		);
		return;
	}
	if (current.room.status === 'lobby') lobby();
	else if (current.room.status === 'finished' && showResults) results();
	else scoreSheet();
	app.querySelectorAll<HTMLElement>('[data-action="share"]').forEach((element) => element.addEventListener('click', share));
	app.querySelectorAll<HTMLElement>('[data-action="rename"]').forEach((element) => element.addEventListener('click', rename));
	setConnection(connection);
}

function lobby() {
	const { room, playerId } = current!;
	const host = room.hostId === playerId;
	app.innerHTML = `${roomBar()}<section class="lobby-layout"><div class="lobby-intro"><p class="eyebrow">PULL UP A CHAIR</p><h1>みんな、<br>そろった？</h1><p class="intro-copy">招待リンクかルームコードを送って、<br>同じテーブルに集まろう。</p><div class="invite-box"><span class="eyebrow">ROOM CODE</span><strong>${room.code}</strong><button class="button button-secondary" data-action="share">招待リンクを共有 <span aria-hidden="true">↗</span></button></div><p class="small muted">参加したときと同じブラウザで開くと、<br>いつでも自分のスコア帳に戻れます。</p></div>
		<div class="lobby-card"><div class="section-heading"><h2>テーブルのメンバー</h2><span>${room.players.length} <small>/ 6人</small></span></div><div class="member-list">${room.players.map((player, index) => `<div class="member">${avatar(player, index)}<div><strong>${escape(player.name)}</strong><span>${player.id === playerId ? 'あなた' : '参加しました'}${player.id === room.hostId ? ' · ホスト' : ''}</span></div>${player.id === playerId ? '<button class="icon-button" data-action="rename" aria-label="自分の名前を変更">✎</button>' : '<span class="member-check" aria-label="参加済み">✓</span>'}</div>`).join('')}${Array.from({ length: Math.max(0, 2 - room.players.length) }, () => '<div class="member empty-member"><span class="avatar">＋</span><span>もうひとりの参加を待っています</span></div>').join('')}</div>
		<div class="lobby-bottom"><p class="small muted">${host ? '2〜6人そろったら、ホストがスタート。' : 'みんながそろったら、ホストがスタートします。'}</p><button class="button button-primary" id="start-game" ${!host || room.players.length < 2 ? 'disabled' : ''}>${host ? 'ゲームをはじめる' : 'ホストの開始を待っています'}<span aria-hidden="true">→</span></button>${!host ? '<button class="text-button leave-button" id="leave-room">このルームから退出</button>' : ''}<p class="form-error" id="lobby-error" role="alert"></p></div></div></section>`;
	document.querySelector('#start-game')!.addEventListener('click', async (event) => {
		const button = event.currentTarget as HTMLButtonElement;
		button.disabled = true;
		try {
			accept(await api(`/${room.code}/start`, 'POST', {}));
		} catch (error) {
			document.querySelector('#lobby-error')!.textContent = errorText(error);
			button.disabled = false;
		}
	});
	document.querySelector('#leave-room')?.addEventListener('click', async () => {
		try {
			await api(`/${room.code}/leave`, 'POST', {});
			stopConnection();
			current = null;
			history.replaceState(null, '', '/');
			home();
		} catch (error) {
			toast(errorText(error));
		}
	});
}

function scoreRows(player: Player, section: 'upper' | 'lower') {
	const own = player.id === current!.playerId;
	return CATEGORIES.filter((category) => category.section === section)
		.map((category) => {
			const entry = player.scores[category.id];
			return `<button class="score-row ${entry ? 'recorded' : ''}${category.id === 'yahtzee' ? ' yahtzee-row' : ''}" data-category="${category.id}" ${own ? '' : 'disabled'} aria-label="${escape(category.name)} ${entry ? `${entry.value}点を修正` : '未記録'}"><span class="category-icon">${category.face ? die(category.face) : `<span class="role-symbol" aria-hidden="true">${({ threeKind: 'Ⅲ', fourKind: 'Ⅳ', fullHouse: '⌂', smallStraight: '↗', largeStraight: '⇗', yahtzee: '✳', chance: '✧' } as Record<string, string>)[category.id]}</span>`}</span><span class="category-name"><strong>${category.name}</strong><small>${category.face ? category.hint : category.english}${entry?.extraYahtzee ? ' · ボーナス +100' : ''}</small></span><span class="score-value ${entry?.value === 0 ? 'zero-score' : ''}">${entry ? entry.value : '<span class="empty-score">＋</span>'}</span>${own && entry ? '<span class="edit-hint" aria-hidden="true">✎</span>' : ''}</button>`;
		})
		.join('');
}
function scoreSheet() {
	const { room, playerId } = current!;
	const player = room.players.find((item) => item.id === activePlayerId) ?? room.players[0];
	const index = room.players.indexOf(player);
	const own = player.id === playerId;
	const score = totals(player.scores);
	const allComplete = room.players.reduce((sum, item) => sum + totals(item.scores).completed, 0);
	app.innerHTML = `${roomBar()}<section class="game-layout"><aside class="game-sidebar"><p class="eyebrow">ON THE TABLE</p><h1>今日の<br>スコア帳。</h1><p class="muted small">振ったら、役をタップして記録。<br>ほかの人のスコアも、すぐ隣に。</p><div class="standings">${rankings(
		room.players,
	)
		.map(
			(entry) =>
				`<button class="standing-row ${entry.player.id === player.id ? 'selected' : ''}" data-player="${entry.player.id}"><span class="standing-rank">${entry.rank.toString().padStart(2, '0')}</span>${avatar(entry.player, room.players.indexOf(entry.player))}<span class="standing-name">${escape(entry.player.name)}${entry.player.id === playerId ? '<small>あなた</small>' : ''}</span><strong>${entry.total}<small>pt</small></strong></button>`,
		)
		.join(
			'',
		)}</div><div class="table-progress"><span>テーブル全体の記録</span><strong>${allComplete} / ${room.players.length * 13}</strong><progress max="${room.players.length * 13}" value="${allComplete}"></progress></div><button class="text-button" data-action="share">ルームに招待する ↗</button></aside>
	<div class="sheet-area"><div class="player-tabs" role="tablist" aria-label="プレイヤーのスコア">${room.players.map((item, itemIndex) => `<button class="player-tab" role="tab" aria-selected="${item.id === player.id}" data-player="${item.id}" aria-controls="player-sheet">${avatar(item, itemIndex)}<span>${escape(item.name)}</span>${item.id === playerId ? '<small>自分</small>' : ''}</button>`).join('')}</div>
	<div class="swipe-label"><span>←</span> 左右にフリックしてプレイヤーを切り替え <span>→</span></div>
	<article class="score-sheet" id="player-sheet" role="tabpanel" aria-label="${escape(player.name)}のスコア"><div class="sheet-heading"><div class="player-heading">${avatar(player, index, true)}<div><p class="eyebrow">${own ? 'YOUR SCORE SHEET' : 'PLAYER SCORE SHEET'}</p><h2>${escape(player.name)}${own ? '<button class="icon-button" data-action="rename" aria-label="自分の名前を変更">✎</button>' : ''}</h2></div></div><span class="turn-count"><strong>${score.completed}</strong><span>/ 13<br>記録済み</span></span></div>
	${!own ? '<div class="view-only">このスコアは閲覧のみです。自分のタブで記録できます。</div>' : ''}
	<div class="score-columns"><section class="score-section"><div class="score-section-title"><h3>数字のスコア</h3><span>UPPER SECTION</span></div>${scoreRows(player, 'upper')}<div class="upper-summary"><div><span>数字の合計</span><strong>${score.upper} <small>/ 63</small></strong></div><progress max="63" value="${Math.min(score.upper, 63)}"></progress><div class="bonus-line"><span>${score.upperBonus ? 'ボーナス達成！' : `あと${63 - score.upper}点でボーナス`}</span><strong class="${score.upperBonus ? 'bonus-earned' : ''}">+35 <small>pt</small></strong></div></div></section>
	<section class="score-section"><div class="score-section-title"><h3>役のスコア</h3><span>LOWER SECTION</span></div>${scoreRows(player, 'lower')}<div class="extra-bonus"><span>追加ヤッツィーボーナス</span><strong>+${score.extraBonus}<small> pt</small></strong></div></section></div>
	<div class="sheet-total"><div><span class="eyebrow">TOTAL SCORE</span><p>${score.completed === 13 ? 'すべての記録がそろいました' : 'いいひと振りを。'}</p></div><strong>${score.total}<span>pt</span></strong></div>
	${score.completed === 13 && room.status !== 'finished' ? '<p class="waiting-note">✓ 記録完了。ほかのプレイヤーの記録を待っています。</p>' : ''}</article>
	<div class="sheet-bottom"><span>${own ? '記録した点数はタップして修正できます。' : 'ほかの人のスコアは変更できません。'}</span>${room.status === 'finished' ? '<button class="text-button" id="view-results">最終結果を見る →</button>' : '<span>すべての点数は自動で保存されます。</span>'}</div></div></section>`;
	app
		.querySelectorAll<HTMLElement>('[data-player]')
		.forEach((button) => button.addEventListener('click', () => selectPlayer(button.dataset.player!)));
	app
		.querySelectorAll<HTMLElement>('[data-category]')
		.forEach((button) => button.addEventListener('click', () => editScore(button.dataset.category as CategoryId)));
	document.querySelector('#view-results')?.addEventListener('click', () => {
		showResults = true;
		render();
		window.scrollTo({ top: 0, behavior: 'smooth' });
	});
	let start: { x: number; y: number } | null = null;
	const sheet = document.querySelector<HTMLElement>('#player-sheet')!;
	sheet.addEventListener('pointerdown', (event) => {
		if (event.isPrimary && event.button === 0) start = { x: event.clientX, y: event.clientY };
	});
	sheet.addEventListener('pointercancel', () => {
		start = null;
	});
	sheet.addEventListener('pointerup', (event) => {
		if (!start) return;
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		start = null;
		if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5)
			selectPlayer(room.players[(index + (dx < 0 ? 1 : -1) + room.players.length) % room.players.length].id);
	});
	const tabs = document.querySelector<HTMLElement>('.player-tabs')!;
	const selectedTab = tabs.querySelector<HTMLElement>('[aria-selected="true"]')!;
	tabs.scrollLeft = selectedTab.offsetLeft - tabs.offsetLeft - 8;
}
function selectPlayer(id: string) {
	activePlayerId = id;
	render();
}

function openModal(content: string) {
	modal.innerHTML = `<div class="modal-content"><button class="modal-close icon-button" aria-label="閉じる">×</button>${content}</div>`;
	modal.querySelector('.modal-close')!.addEventListener('click', () => modal.close());
	if (!modal.open) modal.showModal();
}
modal.addEventListener('click', (event) => {
	if (event.target === modal) modal.close();
});

function editScore(id: CategoryId) {
	const snapshot = current;
	const me = snapshot?.room.players.find((player) => player.id === snapshot.playerId);
	if (!me || me.id !== activePlayerId) return;
	const category = CATEGORIES.find((item) => item.id === id)!;
	const existing = me.scores[id];
	const diceCategory = id === 'threeKind' || id === 'fourKind';
	let version = me.version;
	const code = current!.room.code;
	let selected: number | undefined = existing?.value;
	let useDice = Boolean(existing?.dice);
	const diceValues: (number | null)[] = existing?.dice ? [...existing.dice] : Array(5).fill(null);
	let activeDie = Math.max(
		0,
		diceValues.findIndex((face) => face === null),
	);
	const slotContent = (index: number) =>
		`${diceValues[index] ? die(diceValues[index]!) : '<span class="die die-empty" aria-hidden="true">?</span>'}<small>${index + 1}個目</small>`;
	const scoreInput = diceCategory
		? `<p class="input-label">実際のサイコロと同じ目を選んでください</p><div class="dice-inputs" role="group" aria-label="入力した5個のサイコロ">${diceValues.map((face, index) => `<button class="dice-slot" data-die="${index}" aria-label="${index + 1}個目のサイコロ：${face ? face + 'の目' : '未入力'}" aria-pressed="${index === activeDie}">${slotContent(index)}</button>`).join('')}</div><p class="dice-picker-label" id="dice-picker-label" aria-live="polite"></p><div class="dice-face-options" role="group" aria-label="出目を選択">${[1, 2, 3, 4, 5, 6].map((face) => `<button class="dice-face-option" data-face="${face}" aria-label="${face}の目を選ぶ" aria-pressed="${face === diceValues[activeDie]}">${die(face)}</button>`).join('')}</div><p class="dice-picker-note">入力済みのサイコロをタップすると、その出目を選び直せます。</p><div class="dice-calculation" id="dice-calculation" role="status" aria-live="polite">${existing ? `現在の記録：${existing.value}点。出目を選ぶと再計算できます。` : '5個の出目を選ぶと、得点を自動で計算します。'}</div><button class="button button-secondary discard-score" id="discard-score" aria-pressed="${existing?.value === 0 && !useDice}">役を捨てて0点で記録する</button>`
		: `<p class="input-label">記録する点数を選んでください</p><div class="score-options ${validValues(id).length > 6 ? 'many-options' : ''}">${validValues(
				id,
			)
				.map(
					(value) =>
						`<button class="score-option ${value === 0 ? 'option-zero' : ''}" data-value="${value}" aria-pressed="${selected === value}">${value}<small>${value === 0 ? '役を捨てる' : '点'}</small></button>`,
				)
				.join('')}</div>`;
	openModal(`<p class="eyebrow">${existing ? 'EDIT YOUR SCORE' : 'MARK YOUR ROLL'}</p><h2 id="modal-title">${category.name}</h2><p class="muted">${category.hint}${'fixed' in category ? ` → ${category.fixed}点` : ''}</p>${scoreInput}
	${id !== 'yahtzee' && me.scores.yahtzee?.value === 50 ? `<label class="bonus-checkbox"><input id="extra-yahtzee" type="checkbox" ${existing?.extraYahtzee ? 'checked' : ''}><span>このターンもヤッツィー！<small>追加ボーナス +100点</small></span></label><p class="small muted">対応する数字の欄が空いていれば、まずそこに記録。埋まっていればジョーカールールで役を選んでください。</p>` : ''}
	<p class="form-error" id="score-error" role="alert"></p><button class="button button-primary" id="save-score" ${selected === undefined ? 'disabled' : ''}>${existing ? 'スコアを修正する' : 'スコアを記録する'}<span aria-hidden="true">✓</span></button>${existing ? '<button class="text-button clear-score" id="clear-score">この記録を取り消す</button>' : '<p class="small muted score-modal-note">役が成立しなかった場合は、0点で記録できます。</p>'}`);
	const updateDice = () => {
		if (!diceCategory) return;
		const complete = diceValues.every((face) => face !== null);
		useDice = complete;
		modal.querySelector('#discard-score')!.setAttribute('aria-pressed', 'false');
		const result = modal.querySelector<HTMLElement>('#dice-calculation')!;
		if (complete) {
			const calculated = scoreKindDice(id, diceValues);
			selected = calculated.value;
			result.innerHTML = `<strong>${calculated.value}点</strong><p>${calculated.dice.join(' ＋ ')} ＝ ${calculated.total}</p><small>${calculated.matches ? `${category.name}成立。5個すべての合計が得点です。` : `同じ目が${id === 'threeKind' ? 3 : 4}個以上そろっていないため、0点です。`}</small>`;
		} else {
			selected = undefined;
			result.textContent = 'あと' + diceValues.filter((face) => face === null).length + '個の出目を入力してください。';
		}
		modal.querySelector<HTMLButtonElement>('#save-score')!.disabled = selected === undefined;
	};
	const updateDicePicker = () => {
		if (!diceCategory) return;
		modal.querySelectorAll<HTMLButtonElement>('[data-die]').forEach((button) => {
			const index = Number(button.dataset.die);
			button.innerHTML = slotContent(index);
			button.setAttribute('aria-label', `${index + 1}個目のサイコロ：${diceValues[index] ? diceValues[index] + 'の目' : '未入力'}`);
			button.setAttribute('aria-pressed', String(index === activeDie));
		});
		modal.querySelectorAll<HTMLButtonElement>('[data-face]').forEach((button) => {
			button.setAttribute('aria-pressed', String(Number(button.dataset.face) === diceValues[activeDie]));
		});
		modal.querySelector('#dice-picker-label')!.textContent = `${activeDie + 1}個目の出目を${diceValues[activeDie] ? '変更' : '選択'}`;
	};
	modal.querySelectorAll<HTMLButtonElement>('[data-die]').forEach((button) =>
		button.addEventListener('click', () => {
			activeDie = Number(button.dataset.die);
			updateDicePicker();
		}),
	);
	modal.querySelectorAll<HTMLButtonElement>('[data-face]').forEach((button) =>
		button.addEventListener('click', () => {
			diceValues[activeDie] = Number(button.dataset.face);
			const nextEmpty = diceValues.findIndex((face) => face === null);
			if (nextEmpty !== -1) activeDie = nextEmpty;
			updateDicePicker();
			updateDice();
		}),
	);
	updateDicePicker();
	if (diceCategory && useDice) updateDice();
	modal.querySelector('#discard-score')?.addEventListener('click', () => {
		selected = 0;
		useDice = false;
		modal.querySelector('#discard-score')!.setAttribute('aria-pressed', 'true');
		modal.querySelector('#dice-calculation')!.textContent = 'この項目は0点で記録します。';
		modal.querySelector<HTMLButtonElement>('#save-score')!.disabled = false;
	});
	modal.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((button) =>
		button.addEventListener('click', () => {
			selected = Number(button.dataset.value);
			modal
				.querySelectorAll<HTMLElement>('[data-value]')
				.forEach((item) => item.setAttribute('aria-pressed', String(Number(item.dataset.value) === selected)));
			modal.querySelector<HTMLButtonElement>('#save-score')!.disabled = false;
		}),
	);
	let saving = false;
	const save = async (clear = false) => {
		if (saving || (!clear && selected === undefined)) return;
		saving = true;
		modal.querySelectorAll<HTMLButtonElement>('button').forEach((control) => {
			control.disabled = true;
		});
		try {
			const snapshot = await api(`/${code}/score`, 'PUT', {
				category: id,
				value: clear ? null : selected,
				...(diceCategory && useDice && !clear ? { dice: diceValues } : {}),
				extraYahtzee: !clear && Boolean(modal.querySelector<HTMLInputElement>('#extra-yahtzee')?.checked),
				version,
			});
			modal.close();
			accept(snapshot);
			toast(clear ? '記録を取り消しました' : `${category.name}に${selected}点を記録しました`);
		} catch (error) {
			modal.querySelector('#score-error')!.textContent = errorText(error);
			modal.querySelectorAll<HTMLButtonElement>('button').forEach((control) => {
				control.disabled = false;
			});
			modal.querySelector<HTMLButtonElement>('#save-score')!.disabled = selected === undefined;
			saving = false;
			try {
				const latest = await api(`/${code}`);
				accept(latest);
				version = latest.room.players.find((player) => player.id === latest.playerId)?.version ?? version;
			} catch {
				/* Retain the last confirmed state. */
			}
		}
	};
	modal.querySelector('#save-score')!.addEventListener('click', () => void save());
	modal.querySelector('#clear-score')?.addEventListener('click', () => void save(true));
}

function results() {
	const { room, playerId } = current!;
	const entries = rankings(room.players);
	const winners = entries.filter((entry) => entry.rank === 1);
	app.innerHTML = `${roomBar()}<section class="results-page"><p class="eyebrow">THAT WAS A GOOD GAME.</p><div class="result-emblem" aria-hidden="true">✳</div><h1>おつかれさま！</h1><p class="result-message">${winners.map((entry) => escape(entry.player.name)).join(' と ')}${winners.length > 1 ? ' が同点で優勝です。' : ' の優勝です。'}<br>また、サイコロを囲もう。</p><div class="result-card"><div class="section-heading"><h2>最終結果</h2><span>13 / 13 TURNS</span></div>${entries.map((entry) => `<div class="result-row ${entry.rank === 1 ? 'winner' : ''}"><span class="result-rank">${entry.rank === 1 ? '♛' : entry.rank}</span>${avatar(entry.player, room.players.indexOf(entry.player))}<div class="result-player"><strong>${escape(entry.player.name)}${entry.player.id === playerId ? ' <small>あなた</small>' : ''}</strong><small>数字 ${entry.upper} ＋ 役 ${entry.lower} ＋ ボーナス ${entry.upperBonus + entry.extraBonus}</small></div><strong class="result-total">${entry.total}<small>pt</small></strong></div>`).join('')}</div><div class="result-actions"><button class="button button-primary" id="review-scores">スコアを確認・修正する <span>→</span></button><a class="button button-secondary" href="/">新しいゲームへ</a></div></section>`;
	document.querySelector('#review-scores')!.addEventListener('click', () => {
		showResults = false;
		activePlayerId = playerId;
		render();
	});
}

function share() {
	const code = current!.room.code;
	const url = `${location.origin}/?room=${code}`;
	openModal(
		`<p class="eyebrow">SAVE A SEAT FOR YOUR FRIENDS</p><h2 id="modal-title">同じテーブルに招待</h2><p class="muted">QRコード、招待リンク、ルームコードで参加できます。</p><figure class="invite-qr"><canvas id="invite-qr" role="img" aria-label="ルーム${escape(code)}に参加する招待リンクのQRコード" hidden>招待リンクのQRコード</canvas><figcaption id="invite-qr-status" aria-live="polite">QRコードを作成しています…</figcaption></figure><div class="share-code" aria-label="ルームコード ${escape(code)}">${code}</div><label for="invite-url">招待リンク</label><input id="invite-url" value="${escape(url)}" readonly><button class="button button-primary" id="copy-invite">招待リンクをコピー <span>↗</span></button>${'share' in navigator ? '<button class="button button-secondary share-native" id="native-share">ほかのアプリで共有する</button>' : ''}<p class="small muted">最大6人まで。ゲーム開始後は新しく参加できません。</p>`,
	);
	const canvas = modal.querySelector<HTMLCanvasElement>('#invite-qr')!;
	const qrStatus = modal.querySelector<HTMLElement>('#invite-qr-status')!;
	void toCanvas(canvas, url, {
		width: 224,
		margin: 4,
		errorCorrectionLevel: 'M',
		color: { dark: '#000000', light: '#ffffff' },
	})
		.then(() => {
			if (!canvas.isConnected) return;
			canvas.hidden = false;
			qrStatus.textContent = 'スマートフォンのカメラで読み取って参加';
		})
		.catch(() => {
			if (!qrStatus.isConnected) return;
			qrStatus.textContent = 'QRコードを表示できませんでした。招待リンクかルームコードで参加してください。';
		});
	modal.querySelector('#copy-invite')!.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast('招待リンクをコピーしました');
			modal.close();
		} catch {
			modal.querySelector<HTMLInputElement>('#invite-url')!.select();
			toast('リンクを選択しました。長押ししてコピーしてください。');
		}
	});
	modal.querySelector('#native-share')?.addEventListener('click', async () => {
		try {
			await navigator.share({ title: 'ヤッツィーのスコア帳', text: '同じテーブルでヤッツィーを遊ぼう！', url });
		} catch (error) {
			if (!(error instanceof DOMException && error.name === 'AbortError')) toast('招待リンクをコピーして共有してください。');
		}
	});
}

function rename() {
	const me = current!.room.players.find((player) => player.id === current!.playerId)!;
	openModal(
		`<p class="eyebrow">YOUR NAME AT THE TABLE</p><h2 id="modal-title">名前を変更する</h2><form id="rename-form"><label for="new-name">あなたの名前</label><input id="new-name" maxlength="40" value="${escape(me.name)}" required autocomplete="nickname"><p class="form-error" id="name-error" role="alert"></p><button class="button button-primary" type="submit">変更を保存する <span>✓</span></button></form>`,
	);
	modal.querySelector('#rename-form')!.addEventListener('submit', async (event) => {
		event.preventDefault();
		const button = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		button.disabled = true;
		const name = modal.querySelector<HTMLInputElement>('#new-name')!.value.trim();
		try {
			accept(await api(`/${current!.room.code}/name`, 'PUT', { name }));
			store('yahtzee.name', name);
			modal.close();
		} catch (error) {
			modal.querySelector('#name-error')!.textContent = errorText(error);
			button.disabled = false;
		}
	});
}

function rules() {
	openModal(
		`<p class="eyebrow">A QUICK GUIDE</p><h2 id="modal-title">遊び方と得点</h2><div class="rules-content"><p>サイコロは実物を使って振ります。各ターンで最大3回振り、ひとつの空いている得点欄に記録。全員が13項目を埋めたら、合計点で勝負です。</p><h3>記録するとき</h3><p>自分のスコアの役をタップして、点数を選びます。成立しない役を捨てるときは0点。間違えた記録は、同じ項目をタップして修正・取り消しできます。</p><h3>数字のスコアとボーナス</h3><p>1〜6それぞれの目の合計を記録します。数字の合計が63点以上なら、35点を自動で加算します。</p><h3>役のスコア</h3><dl>${CATEGORIES.filter(
			(category) => category.section === 'lower',
		)
			.map(
				(category) => `<div><dt>${category.name}</dt><dd>${category.hint}${'fixed' in category ? `：${category.fixed}点` : ''}</dd></div>`,
			)
			.join('')}</dl>
<h3>ジョーカールール</h3>
<p>ヤッツィー欄をすでに使ったあとに5個同じ目が出たとき、ほかの欄に記録するための特別ルールです。ヤッツィー欄が50点でも0点でも使えます。</p>
<p><strong>例：6・6・6・6・6が出たら</strong></p>
<ol>
<li><strong>シックス欄が空いている</strong><br>シックスに30点を記録します。</li>
<li><strong>シックス欄は記録済み</strong><br>空いている役の欄から1つを選びます。記録できる点数は下の表のとおりです。</li>
<li><strong>役の欄もすべて記録済み</strong><br>残っている数字の欄に0点を記録します。</li>
</ol>
<table class="joker-score-table"><caption>例：6が5個・シックス欄は記録済み</caption>
<thead><tr><th scope="col">選んだ役の欄</th><th scope="col">得点</th></tr></thead>
<tbody><tr><td>スリーカード</td><td>30点</td></tr><tr><td>フォーカード</td><td>30点</td></tr><tr><td>フルハウス</td><td>25点</td></tr><tr><td>スモールストレート</td><td>30点</td></tr><tr><td>ラージストレート</td><td>40点</td></tr><tr><td>チャンス</td><td>30点</td></tr></tbody></table>
<p>スリーカード・フォーカードは、それぞれ「3個以上同じ」「4個以上同じ」の条件を満たすため、チャンスと同じく<strong>5個すべての合計</strong>です。フルハウスやストレートは、同じ目5個をその役の代わりに使えます。</p>
<h3>ヤッツィーの追加100点ボーナス</h3>
<p>ヤッツィー欄に50点を記録したあと、再び5個同じ目が出たターンは、<strong>記録先の得点に加えて100点</strong>のボーナスが付きます。アプリでは、その項目の入力時に「このターンもヤッツィー！」を選んで追加します。</p>
<p>たとえばシックス欄に30点を記録した場合、そのターンの加点は<strong>30＋100＝130点</strong>です。</p>
<p>ヤッツィー欄が0点の場合は、ジョーカーは使えますが<strong>100点の追加ボーナスはありません。</strong></p>
<p class="small muted">スリーカード・フォーカードは5個の出目から自動計算します。それ以外の役の成立と、ジョーカーの記録先はテーブルのみんなで確認してください。プレイ順の制限は行いません。</p><a href="https://instructions.hasbro.com/en-us/instruction/yahtzee" target="_blank" rel="noreferrer" class="text-link">Hasbro公式ルール ↗</a></div>`,
	);
}
document.querySelector('#rules-button')!.addEventListener('click', rules);

async function loadRoom(code: string) {
	try {
		enter(await api(`/${encodeURIComponent(code)}`));
	} catch (error) {
		home(code, errorText(error));
	}
}
window.addEventListener('online', () => {
	if (current?.playerId) connect();
});
window.addEventListener('offline', () => setConnection('offline'));
document.addEventListener('visibilitychange', () => {
	if (!document.hidden && current?.playerId) connect();
});
window.addEventListener('pageshow', (event) => {
	if (event.persisted && current?.playerId) connect();
});
const initialCode = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
if (initialCode) void loadRoom(initialCode);
else home();
