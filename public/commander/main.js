// Commander (Spike Rush): voice, hand signals, and typed orders → Jev → four agents.
// Vs Bots runs the whole match in this tab. Multiplayer connects to a room on the server,
// which runs the match and streams this player their team's view.
import { createBrains } from './brain.js';
import { createOpponentCommander } from './opponent.js';
import { SIGNALS, createGestures } from './gestures.js';
import { createCamera, createPovRenderer } from './pov.js';
import { createRenderer } from './render.js';
import { OWN_COLORS, TEAMS, actionLabel, createGame, stepGame, teamView } from './sim.js';
import { createVoice } from './voice.js';
import { MAPS, zoneAt } from './world.js';

const STEP = 1 / 60;
const POINTER_MS = 8000;
const $ = id => document.getElementById(id);

const ZONE_TERMS = ['A Site', 'B Site', 'A Main', 'B Main', 'Mid', 'A Link', 'B Link', 'spike', 'flank', 'regroup', 'rotate'];
const keytermsFor = team => [...TEAMS[team].names, ...ZONE_TERMS, team === 'attack' ? 'plant' : 'defuse'];

// What each hand signal says. The words go to Jev like any other order.
function signalOrder(name, team, pointed) {
  const attack = team === 'attack';
  const [a, b, c, d] = TEAMS[team].names;
  const carrier = view?.units.find(u => u.carrying)?.name ?? a;
  const orders = {
    Thumb_Up: pointed ? 'Everyone push there!' : 'Everyone push forward!',
    Open_Palm: 'Everyone hold your positions!',
    Closed_Fist: 'Everyone regroup!',
    Thumb_Down: attack ? 'Everyone fall back to spawn!' : 'Everyone fall back to Defender Spawn!',
    Victory: attack ? `${a} and ${b} push A Site. ${c} and ${d} push B Site.` : `${a} and ${b} hold A Site. ${c} and ${d} hold B Site.`,
    ILoveYou: attack
      ? `${carrier}, plant the spike${pointed ? ' there' : ' on B Site'}. Everyone else push with them.`
      : 'Everyone retake the site and defuse the spike!',
  };
  const label = name === 'ILoveYou' ? (attack ? 'Plant' : 'Retake') : SIGNALS[name].label;
  return { text: orders[name], gesture: { ...SIGNALS[name], label } };
}

const canvas = $('map');
const renderer = createRenderer(canvas);
const povCanvas = $('pov');
const pov = createPovRenderer(povCanvas);
const minimap = createRenderer($('minimap'));
const camera = createCamera();
const opponentCommander = createOpponentCommander();

let session = null; // { kind: 'bots' | 'online', team }
let game = null; // bot games only: the local simulation
let brains = null; // bot games only: the attackers' Jev brains
let online = null; // multiplayer connection: { ws, code, team, host, players, pending, seq, jev }
let view = null; // what's on screen: a teamView, local or streamed from the server
let pointer = null; // { x, y, at } marked by clicking the map or pointing at the camera
let resultShown = false;
let is3d = false; // first-person view of one agent, instead of the top-down map
let watchedId = null; // which agent that is
const positions = new Map(); // smoothed unit positions for multiplayer

// ---------- view: the top-down map (default) or one agent's first-person view ----------

const ownUnits = () => (view?.units ?? []).filter(u => u.team === view.team);
const watched = () => ownUnits().find(u => u.id === watchedId && u.alive) ?? null;

function setView(next) {
  is3d = next;
  $('arena').dataset.view = is3d ? 'pov' : 'map';
  $('hint').textContent = is3d
    ? 'Orders here go to this agent. ←/→ or thumb: switch agent. Tab or pinch: map.'
    : 'Click the map or point up to mark a spot, then say “push there”. Tab or pinch: first person.';
  if (is3d) {
    if (!watched()) watchedId = ownUnits().find(u => u.alive)?.id ?? null;
    minimap.resize();
  } else {
    renderer.resize();
  }
  updateScorebar();
}

// Step through your living agents in top-bar order, wrapping around.
function cycleAgent(dir) {
  const order = ownUnits();
  if (!order.some(u => u.alive)) return;
  const from = order.findIndex(u => u.id === watchedId);
  for (let step = 1; step <= order.length; step++) {
    const next = order[(((from + dir * step) % order.length) + order.length) % order.length];
    if (next.alive) return watchAgent(next);
  }
}

function watchAgent(u) {
  watchedId = u.id;
  showToast(u.name.toUpperCase());
  updateScorebar();
}

let toastTimer = null;
function showToast(text) {
  $('toast').hidden = false;
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 700);
}

const activePointer = () => (pointer && performance.now() - pointer.at < POINTER_MS ? pointer : null);

// ---------- screens ----------

function showScreen(name) {
  $('overlay').hidden = !name;
  for (const id of ['screenMenu', 'screenBots', 'screenOnline', 'screenLobby', 'screenPause', 'screenSettings', 'screenResult']) {
    $(id).hidden = id !== name;
  }
  // Keyboard users land on the thing they most likely want: the primary action if it's
  // available, else the first thing they can use. Closing hands focus back to the page.
  const screen = name && $(name);
  const focus = screen && (screen.querySelector('.primary:not(:disabled)')
    ?? screen.querySelector('button:not(:disabled), input:not(:disabled)'));
  if (focus) focus.focus();
  else if (!name) document.activeElement?.blur();
  updateTitle();
}

function goToMenu() {
  leaveOnline();
  opponentCommander.reset();
  session = null;
  game = null;
  brains = null;
  view = null;
  history.replaceState(null, '', location.pathname);
  updateTeamUi();
  showScreen('screenMenu');
}

let botOpponent = 'scripted'; // who commands the defenders: 'scripted' or 'openai'
$('playBots').onclick = () => {
  setStatus('botsStatus', '');
  showScreen('screenBots');
};
$('botsScripted').onclick = () => startBotGame('scripted');
$('botsOpenAI').onclick = () => startBotGame('openai');
$('botsBack').onclick = () => showScreen('screenMenu');
$('playOnline').onclick = () => {
  setStatus('onlineStatus', '');
  showScreen('screenOnline');
};
$('onlineBack').onclick = goToMenu;
$('lobbyLeave').onclick = goToMenu;
$('resultMenu').onclick = goToMenu;
$('pauseMenu').onclick = goToMenu;
$('resume').onclick = () => showScreen(null);

// ---------- settings ----------

// What each toggle shows, and what it defaults to. Stored per machine.
const SETTINGS = [
  ['cards', 'Agent cards', false],
  ['feed', 'Kill feed', true],
  ['minimap', 'Minimap and zone name', true],
  ['stats', 'Jev numbers', true],
  ['hints', 'Control hints', true],
];
const SETTINGS_KEY = 'commander:settings';
let settings = { ...Object.fromEntries(SETTINGS.map(([key, , value]) => [key, value])), ...readJson(SETTINGS_KEY) };

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {}; // private windows and blocked storage
  }
}

function applySettings() {
  for (const [key] of SETTINGS) document.body.dataset[key] = settings[key] ? 'on' : 'off';
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not remembering is not worth interrupting anyone over.
  }
}

function buildSettings() {
  $('toggles').replaceChildren(...SETTINGS.map(([key, label]) => {
    const button = el('button', {
      type: 'button', className: 'toggle', textContent: settings[key] ? 'On' : 'Off', title: label,
      onclick: () => {
        settings[key] = !settings[key];
        applySettings();
        buildSettings();
      },
    });
    button.setAttribute('aria-pressed', String(Boolean(settings[key])));
    button.setAttribute('aria-label', label);
    return el('div', { className: 'toggle-row' }, [el('span', { textContent: label }), button]);
  }));
}

let settingsFrom = 'screenMenu';
const openSettings = from => {
  settingsFrom = from;
  buildSettings();
  showScreen('screenSettings');
};
$('menuSettings').onclick = () => openSettings('screenMenu');
$('pauseSettings').onclick = () => openSettings('screenPause');
$('settingsBack').onclick = () => showScreen(settingsFrom);
applySettings();
$('createRoom').onclick = () => connectOnline(null);
$('joinForm').onsubmit = e => {
  e.preventDefault();
  const code = $('joinCode').value.trim().toUpperCase();
  if (code) connectOnline(code);
};
$('again').onclick = () => {
  if (session?.kind === 'bots') startBotGame(botOpponent);
  else if (online?.host && opponentPresent()) online.ws.send(JSON.stringify({ type: 'start' }));
  else if (online) showScreen('screenLobby');
};
const opponentPresent = () => Boolean(online?.players?.attack && online?.players?.defend);
$('startMatch').onclick = () => online?.ws.send(JSON.stringify({ type: 'start' }));

// ---------- microphone and camera ----------

// Asked once, then remembered on this machine, so you don't re-enable them every visit.
// The browser remembers the permission itself; this remembers whether you wanted them on.
const DEVICE_KEY = 'commander:devices';

function readDevices() {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY)) ?? {};
  } catch {
    return {}; // private windows and blocked storage: just ask again
  }
}

function saveDevices(patch) {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...readDevices(), ...patch }));
  } catch {
    // Not being able to remember is not worth interrupting anyone over.
  }
}

$('permsBtn').onclick = async () => {
  setStatus('permsStatus', 'Waiting for your browser…');
  saveDevices({ asked: true, mic: true, camera: true });
  await ensureMic();
  await startCamera();
  syncPerms();
};

// The card stays out of the way once both are running, and nothing can start without them:
// you command the squad by voice and hand signal, so half the controls is not a game.
function syncPerms() {
  const ready = playable();
  $('permsCard').hidden = ready || !window.isSecureContext;
  if (!ready) {
    const missing = [voice.enabled ? null : 'mic', gestures ? null : 'camera'].filter(Boolean);
    setStatus('permsStatus', `Needed to play (${missing.join(' and ')}).`);
  }
  const blocked = !ready && window.isSecureContext;
  for (const id of ['playBots', 'playOnline', 'botsScripted', 'botsOpenAI', 'createRoom']) $(id).disabled = blocked;
  $('joinCode').disabled = blocked;
  $('joinForm').querySelector('button').disabled = blocked;
  $('menuNote').textContent = blocked ? 'Allow the mic and camera to play.' : '';
}

// Without a secure page the browser won't give us either, so don't lock someone out entirely.
const playable = () => (voice.enabled && Boolean(gestures)) || !window.isSecureContext;

// On later visits, turn back on whatever was wanted last time. The browser only reopens the
// devices without a click because it already granted this page permission.
async function restoreDevices() {
  const devices = readDevices();
  if (devices.asked && window.isSecureContext) {
    if (devices.mic) await ensureMic();
    if (devices.camera) await startCamera();
  }
  syncPerms();
}

// ---------- vs bots ----------

function startBotGame(opponent = botOpponent) {
  leaveOnline();
  botOpponent = opponent;
  opponentCommander.reset();
  session = { kind: 'bots', team: 'attack' };
  game = createGame({ defenders: 'bots', opponent });
  brains = createBrains();
  view = teamView(game, 'attack');
  beginMatch();
}

// ---------- multiplayer ----------

function connectOnline(code) {
  leaveOnline();
  setStatus('onlineStatus', code ? `Joining ${code}…` : 'Creating a game…');
  showScreen('screenOnline');
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/api/room${code ? `?join=${encodeURIComponent(code)}` : ''}`);
  const connection = { ws, code: null, team: null, host: false, players: {}, pending: new Map(), seq: 0, jev: null, closedReason: '' };
  online = connection;
  ws.onmessage = event => {
    if (online === connection) handleServer(connection, JSON.parse(event.data));
  };
  ws.onclose = () => {
    if (online !== connection) return;
    online = null;
    for (const { reject } of connection.pending.values()) reject(new Error('Disconnected'));
    session = null;
    view = null;
    updateTeamUi();
    showScreen('screenOnline');
    setStatus('onlineStatus', connection.closedReason || 'Disconnected from the game server.', 'error');
  };
}

function handleServer(connection, message) {
  switch (message.type) {
    case 'joined':
      Object.assign(connection, { code: message.code, team: message.team, host: message.host });
      session = { kind: 'online', team: message.team };
      view = null;
      // A refreshed guest rejoins; the host doesn't (their room closes when they leave).
      if (!message.host) history.replaceState(null, '', `${location.pathname}?join=${message.code}`);
      voice.setKeyterms(keytermsFor(message.team));
      updateTeamUi();
      renderLobby();
      showScreen('screenLobby');
      break;
    case 'lobby':
      connection.players = message.players;
      renderLobby();
      if (resultShown) updateResultActions();
      break;
    case 'started':
      view = null;
      beginMatch();
      break;
    case 'state':
      view = message.view;
      connection.jev = message.jev;
      break;
    case 'plan': {
      const waiter = connection.pending.get(message.id);
      connection.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error));
      else waiter?.resolve(message);
      break;
    }
    case 'opponent-left':
      if (!view?.result) showScreen('screenLobby');
      break;
    case 'closed':
    case 'error':
      connection.closedReason = message.reason ?? message.message;
      break;
  }
}

async function renderLobby() {
  if (!online?.code) return;
  const { code, team, host, players } = online;
  $('lobbyCode').textContent = code;
  $('lobbyIntro').textContent = `You command the ${TEAMS[team].label.toLowerCase()}. Share this code or link with your opponent:`;
  for (const [id, seat] of [['seatAttack', 'attack'], ['seatDefend', 'defend']]) {
    const filled = Boolean(players?.[seat]);
    $(id).classList.toggle('filled', filled);
    $(id).querySelector('.who').textContent = seat === team ? 'You' : filled ? 'Opponent ready' : 'Waiting for opponent…';
  }
  const ready = Boolean(players?.attack && players?.defend);
  $('startMatch').hidden = !host;
  $('startMatch').disabled = !ready;
  if (!host) setStatus('lobbyStatus', 'Waiting for the host to start the match…');
  else setStatus('lobbyStatus', ready ? 'Both commanders are here.' : 'Waiting for your opponent to join…');
  $('inviteLink').value = await inviteUrl(code);
}

// The invite has to work from another machine: prefer the server's public (tunnel) address,
// then its LAN address, over localhost.
const isLocalHost = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
let serverInfo;
async function inviteUrl(code) {
  serverInfo ??= await fetch('/api/info').then(res => res.json()).catch(() => ({ public: null, lan: [] }));
  const local = isLocalHost(location.hostname);
  const origin = serverInfo.public || (local && serverInfo.lan[0]) || location.origin;
  $('inviteNote').textContent = isLocalHost(new URL(origin).hostname)
    ? 'This link only works on this computer. Run npm run online for a link anyone can open.'
    : '';
  return `${origin}/commander/?join=${code}`;
}

$('copyInvite').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('inviteLink').value);
    $('copyInvite').textContent = 'Copied';
  } catch {
    $('inviteLink').select();
    $('copyInvite').textContent = 'Press ⌘C';
  }
  setTimeout(() => { $('copyInvite').textContent = 'Copy link'; }, 1500);
};

function leaveOnline() {
  if (!online) return;
  const { ws } = online;
  online = null;
  ws.close();
}

// ---------- matches ----------

function beginMatch() {
  if (readDevices().mic !== false) ensureMic();
  resultShown = false;
  positions.clear();
  $('log').replaceChildren();
  $('feed').replaceChildren();
  $('caption').textContent = '';
  updateTeamUi();
  buildSquadCards();
  watchedId = null; // picked from the first view that has your squad in it
  buildScorebar();
  setView(is3d);
  showScreen(null);
}

function showResult() {
  resultShown = true;
  const won = view.result.winner === session.team;
  $('resultTitle').textContent = won ? 'Victory' : 'Defeat';
  $('resultTitle').className = won ? 'win' : 'lose';
  $('resultText').textContent = view.result.reason;
  updateResultActions();
  showScreen('screenResult');
}

function updateResultActions() {
  if (session.kind === 'bots') {
    $('again').hidden = false;
    $('again').textContent = 'Play again';
    setStatus('resultStatus', '');
  } else if (!opponentPresent()) {
    $('again').hidden = false;
    $('again').textContent = 'Back to lobby';
    setStatus('resultStatus', 'Your opponent left.');
  } else {
    $('again').hidden = !online?.host;
    $('again').textContent = 'Rematch';
    setStatus('resultStatus', online?.host ? '' : 'Waiting for the host to start a rematch…');
  }
}

// ---------- orders ----------

// Speaking takes seconds, so waiting for the finished sentence makes the squad feel slow.
// Instead we interpret the partial transcript while you're still talking, apply it, and
// reconcile when the final transcript arrives (identical text costs nothing extra).
const SPECULATE_AFTER_MS = 120; // the partial must stop changing for this long
const SPECULATE_MIN_WORDS = 3;
let guess = null; // { text, entry, promise, applied, stale, seq }
let speculateTimer = null;
let speculateEnabled = true;
let commandSeq = 0;
// One record per spoken utterance, for measuring how quickly the squad reacts.
let utterance = null;
const utterances = [];
const sameWords = (a, b) => a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() === b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

function onInterimTranscript(text) {
  $('caption').textContent = text;
  if (!text.trim()) return;
  utterance ??= { heardAt: performance.now(), actedAt: 0 };
  clearTimeout(speculateTimer);
  if (!speculateEnabled || !canCommand()) return;
  if (text.trim().split(/\s+/).length < SPECULATE_MIN_WORDS) return;
  if (guess && sameWords(guess.text, text)) return;
  speculateTimer = setTimeout(() => speculate(text), SPECULATE_AFTER_MS);
}

function speculate(text) {
  if (guess?.promise) return; // one guess in flight at a time
  const entry = guess?.entry ?? addLogEntry('voice', text, null, true);
  const g = { text, entry, promise: null, applied: false, stale: false, seq: ++commandSeq };
  guess = g;
  setEntryText(entry, text, '⚡');
  g.promise = interpret({ text, seq: g.seq, only: commandTarget() })
    .then(result => {
      if (result.stale) return;
      renderPlan(entry, result, true);
      g.applied = !result.ignored;
      // the first moment the squad moved on this utterance
      if (g.applied && !g.stale && utterance) utterance.actedAt ||= performance.now();
    })
    .catch(error => showEntryError(entry, error))
    .finally(() => { g.promise = null; });
}

// The finished sentence. If we already acted on exactly these words, keep those orders.
async function onFinalTranscript(text) {
  clearTimeout(speculateTimer);
  $('caption').textContent = text;
  const u = utterance ?? { heardAt: performance.now(), actedAt: 0 };
  utterance = null;
  u.finalAt = performance.now();
  const g = guess;
  guess = null;
  let reused = false;
  if (g && sameWords(g.text, text)) {
    await g.promise; // nearly always already resolved
    reused = g.applied;
  }
  if (reused) {
    setEntryText(g.entry, text, '');
  } else if (g) {
    g.stale = true; // its orders must not overwrite the finished sentence's
    setEntryText(g.entry, text, '');
    await runCommand(g.entry, { text, seq: ++commandSeq });
  } else {
    await issueCommand({ source: 'voice', text, seq: ++commandSeq });
  }
  u.settledAt = performance.now();
  utterances.push({
    text,
    speculated: reused || Boolean(u.actedAt),
    reusedGuess: reused,
    // how long after we first heard you the squad moved, and when the final orders landed
    actedAfterMs: Math.round((u.actedAt || u.settledAt) - u.heardAt),
    settledAfterMs: Math.round(u.settledAt - u.heardAt),
    afterYouStopMs: Math.round(u.settledAt - u.finalAt),
  });
  if (utterances.length > 20) utterances.shift();
}

const canCommand = () => matchActive();
// First-person is one agent's view, so every order given there is for them alone.
const commandTarget = () => (is3d ? watched()?.name : undefined);
const interpret = request => (session.kind === 'bots'
  ? brains.interpretCommand(game, session.team, request)
  : sendCommand(request));

async function issueCommand({ source, text, gesture, seq }) {
  if (!text?.trim()) return;
  if (!session || !view || view.result) {
    setStatus('micStatus', 'Start a match first.', 'error');
    return;
  }
  const only = commandTarget();
  await runCommand(addLogEntry(source, only ? `→ ${only}: ${text}` : text, gesture), { text, gesture, seq, only });
}

async function runCommand(entry, { text, gesture, seq = ++commandSeq, only = commandTarget() }) {
  const p = activePointer();
  try {
    renderPlan(entry, await interpret({ text, gesture, pointer: p && { x: p.x, y: p.y }, only, seq }));
  } catch (error) {
    showEntryError(entry, error);
  }
}

function showEntryError(entry, error) {
  entry.querySelector('.plan').replaceChildren();
  entry.querySelector('.meta').replaceChildren(el('span', { className: 'err', textContent: `Jev failed: ${error.message}` }));
}

function sendCommand(request) {
  const connection = online;
  if (!connection) return Promise.reject(new Error('Not connected'));
  const id = ++connection.seq;
  connection.ws.send(JSON.stringify({ type: 'command', id, ...request }));
  return new Promise((resolve, reject) => {
    connection.pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (connection.pending.delete(id)) reject(new Error('No answer from the game server'));
    }, 15000);
  });
}

function setEntryText(entry, text, mark) {
  const said = entry.querySelector('.said');
  said.replaceChildren(el('span', { className: 'src', textContent: said.querySelector('.src').textContent }), text);
  entry.classList.toggle('early', Boolean(mark));
}

function addLogEntry(source, text, gesture, early = false) {
  const icon = { voice: 'Voice', text: 'Typed', hand: 'Sign' }[source];
  const entry = el('div', { className: `entry${early ? ' early' : ''}` }, [
    el('div', { className: 'said' }, [el('span', { className: 'src', textContent: icon }), text]),
    el('div', { className: 'plan', textContent: 'Jev is reading the order…' }),
    el('div', { className: 'meta' }),
  ]);
  const log = $('log');
  log.prepend(entry);
  while (log.children.length > 30) log.lastChild.remove();
  return entry;
}

function renderPlan(entry, { plan, latency, tokens, ignored, isOrder, stale }, early = false) {
  const pct = v => `${Math.round(v * 100)}%`;
  if (stale) {
    entry.querySelector('.plan').replaceChildren(el('span', { className: 'skip', textContent: 'Superseded by a newer order' }));
    entry.classList.add('ignored');
    return;
  }
  if (ignored) {
    entry.querySelector('.plan').replaceChildren(
      el('span', { className: 'skip', textContent: `Ignored: Jev read this as chatter, not an order (${pct(isOrder)} order)` }));
    entry.querySelector('.meta').textContent = `Jev ${Math.round(latency)} ms · ${tokens ?? '?'} tokens`;
    entry.classList.add('ignored');
    return;
  }
  const rows = plan.flatMap(p => {
    if (!p.applied) {
      return [
        el('span', { className: 'skip', textContent: p.name }),
        el('span', { className: 'skip', textContent: 'not addressed' }),
        el('span', { className: 'p', textContent: pct(p.addressed), title: 'P(addressed)' }),
      ];
    }
    return [
      el('span', { textContent: p.name }),
      el('span', { textContent: `${p.order} → ${p.target}`, title: `addressed ${pct(p.addressed)} · order ${pct(p.orderP)} · target ${pct(p.targetP)}` }),
      el('span', { className: 'p', textContent: pct(p.orderP * p.targetP), title: 'P(order) × P(target)' }),
    ];
  });
  entry.querySelector('.plan').replaceChildren(...rows);
  entry.querySelector('.meta').textContent = `${early ? 'acting early · ' : ''}Jev ${Math.round(latency)} ms · ${tokens ?? '?'} tokens`;
}

const SQUAD_ONLY_SIGNALS = { Victory: '✌️ Split', ILoveYou: '🤟 Special' };

// Hand tracking keeps running while a menu is up (so the preview still works), but nothing it
// sees should reach the match behind the overlay.
const matchActive = () => Boolean(session && view && !view.result && $('overlay').hidden);

function handleSignal(name) {
  if (!matchActive()) return;
  if (is3d && SQUAD_ONLY_SIGNALS[name]) {
    showSign(`${SQUAD_ONLY_SIGNALS[name]}: map view only`);
    return;
  }
  const { text: said, gesture } = signalOrder(name, session.team, Boolean(activePointer()));
  // A signal carries no names, so in first-person it speaks to the agent you're watching.
  const u = is3d ? watched() : null;
  const text = u ? said.replace(/^Everyone/, u.name) : said;
  showSign(`${gesture.emoji} ${gesture.label}`);
  issueCommand({ source: 'hand', text, gesture });
}

// ---------- frame loop ----------

const paused = () => !$('screenPause').hidden || !$('screenSettings').hidden;
let last = performance.now();
let accumulator = 0;
let lastHud = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (session?.kind === 'bots' && game) {
    if (!game.result && !paused()) {
      accumulator += dt;
      while (accumulator >= STEP) {
        stepGame(game, STEP);
        accumulator -= STEP;
      }
      brains.update(game, 'attack');
      opponentCommander.update(game);
    }
    view = teamView(game, 'attack');
  }
  if (session?.kind === 'online') smoothPositions(dt);
  const smoothed = session?.kind === 'online' ? positions : null;
  if (is3d && !watched()) cycleAgent(1); // the agent you were watching died
  const u = is3d ? watched() : null;
  if (u) {
    const at = unit => smoothed?.get(unit.id) ?? unit;
    pov.setPointer(activePointer());
    pov.draw(view, u, camera.update({ ...u, ...at(u) }, dt), at);
    minimap.draw(view, { pointer: activePointer(), positions: smoothed, focusId: u.id, mini: true });
  } else {
    renderer.draw(view, { pointer: activePointer(), positions: smoothed, focusId: watchedId });
  }
  if (view?.result && !resultShown && session) {
    opponentCommander.reset();
    showResult();
  }
  if (now - lastHud > 100) {
    lastHud = now;
    updateHud();
    syncListening();
  }
  requestAnimationFrame(frame);
}

// Snapshots arrive 20 times a second; ease units toward them so movement stays smooth.
function smoothPositions(dt) {
  if (!view) return;
  const k = 1 - Math.exp(-dt * 18);
  const present = new Set();
  for (const u of view.units) {
    present.add(u.id);
    const p = positions.get(u.id);
    if (!p || Math.hypot(p.x - u.x, p.y - u.y) > 6) positions.set(u.id, { x: u.x, y: u.y });
    else {
      p.x += (u.x - p.x) * k;
      p.y += (u.y - p.y) * k;
    }
  }
  for (const id of positions.keys()) if (!present.has(id)) positions.delete(id);
}

// ---------- HUD ----------

// An accurate title: which match you're in, or that you're in the menus.
function updateTitle() {
  const where = session && $('overlay').hidden
    ? `${TEAMS[session.team].label} · ${session.kind === 'online' ? online?.code ?? 'online' : 'vs bots'}`
    : 'Menu';
  const title = `Commander — ${where}`;
  if (document.title !== title) document.title = title;
}

function updateTeamUi() {
  const team = session?.team;
  // The card keeps its place between matches; only what it says changes.
  $('teamBadge').className = `badge ${team ?? ''}`;
  $('teamBadge').textContent = team
    ? `${TEAMS[team].label}${session.kind === 'online' ? ` · ${online?.code ?? ''}` : ' · vs bots'}`
    : 'No match';
  $('textInput').placeholder = team === 'defend'
    ? 'e.g. “Echo hold A, Golf rotate B”…'
    : 'e.g. “Alpha and Bravo push B”…';
  if (team) voice.setKeyterms(keytermsFor(team));
  $('scorebar').hidden = !team;
  if (!team) {
    $('opponentCard').hidden = true;
    $('squad').replaceChildren();
    $('scoreClock').textContent = '–';
    $('roundLabel').textContent = '';
    $('jevStats').textContent = '—';
  }
}

// Valorant-style top bar: your agents (left, in switching order), the clock, then theirs.
// The dead drop off the bar.
// Online, the match starts before the first snapshot arrives, so the bar is (re)built as soon
// as your squad shows up in a view.
let scorebarKey = '';

function buildScorebar() {
  const portrait = (u, onclick) => {
    const node = el('button', {
      type: 'button', className: 'portrait', title: u.name, style: `--agent:${u.color}`, onclick,
    }, [
      // Initial only: the same letter is drawn inside the agent's dot on the map, and the
      // full name sits under it there.
      el('span', { className: 'face', textContent: /^E\d/.test(u.name) ? u.name.slice(1) : u.name[0] }),
      el('span', { className: 'bar' }, [el('i')]),
    ]);
    node.dataset.id = u.id;
    return node;
  };
  const own = ownUnits();
  scorebarKey = own.map(u => u.id).join(',');
  $('squadBar').replaceChildren(...own.map(u => portrait(u, () => watchAgent(u))));
  // The whole enemy roster, named and coloured from the start; what changes is how they look.
  $('enemyBar').replaceChildren(...(view.roster ?? []).map(u => portrait(u)));
}


function updateScorebar() {
  if (!view || !session) return;
  const own = ownUnits();
  if (own.map(u => u.id).join(',') !== scorebarKey) buildScorebar();
  if ($('enemyBar').children.length !== (view.roster?.length ?? 0)) buildScorebar();
  // Never leave the highlight on someone who is down, in either view.
  if (!own.some(u => u.id === watchedId && u.alive)) watchedId = own.find(u => u.alive)?.id ?? null;
  for (const u of own) {
    const chip = $('squadBar').querySelector(`[data-id="${u.id}"]`);
    if (!chip) continue;
    chip.classList.toggle('down', !u.alive);
    chip.classList.toggle('active', u.id === watchedId);
    chip.querySelector('.bar i').style.width = `${(u.hp / u.maxHp) * 100}%`;
    const state = u.alive ? `${Math.round(u.hp)} HP` : 'down';
    chip.setAttribute('aria-label', `${u.name}, ${state}${u.id === watchedId ? ', watching' : ''}`);
    chip.setAttribute('aria-pressed', String(u.id === watchedId));
  }
  for (const u of view.roster ?? []) {
    const chip = $('enemyBar').querySelector(`[data-id="${u.id}"]`);
    if (!chip) continue;
    chip.classList.toggle('down', u.down);
    // Dimmed while nobody on your team has eyes on them: their health is unknown.
    chip.classList.toggle('unseen', !u.seen && !u.down);
    chip.querySelector('.bar i').style.width = `${(u.seen ? u.hp : 1) * 100}%`;
    // The dimming says this in colour; the label says it in words.
    const state = u.down ? 'down' : u.seen ? `${Math.round(u.hp * 100)} HP, in sight` : 'not in sight';
    chip.setAttribute('aria-label', `${u.name}, ${state}`);
  }
}

function buildSquadCards() {
  $('squad').replaceChildren(...TEAMS[session.team].names.map((name, i) => el('div', {
    className: 'agent', style: `--agent:${OWN_COLORS[i]}`, onclick: () => {
      const u = ownUnits()[i];
      if (u?.alive) watchAgent(u);
    },
  }, [
    el('div', { className: 'top' }, [el('span', { className: 'name' }), el('span', { className: 'brain' })]),
    el('div', { className: 'hp' }, [el('i')]),
    el('div', { className: 'doing' }),
    el('div', { className: 'order' }),
    el('div', { className: 'probs' }),
  ])));
}

// The enemy commander's status and current plan. Only in bot games against OpenAI: with
// scripted bots or another player there is nothing to show.
function updateOpponentHud() {
  const openai = session?.kind === 'bots' && game?.opponent === 'openai';
  $('opponentCard').hidden = !openai;
  if (!openai) return;
  const s = game.botCommander;
  const labels = {
    waiting: 'waiting for a fresh plan',
    thinking: 'planning…',
    active: `${s?.model} · ${s?.latency} ms · ${s?.plans} plans`,
    mock: `mock · ${s?.plans} plans`,
    fallback: 'unavailable · scripted defense',
  };
  const text = game.result ? 'round finished' : labels[s?.status] ?? 'starting…';
  setStatus('opponentStatus', text, s?.status === 'fallback' ? 'error' : '');
  $('opponentStatus').title = s?.error || 'The enemy commander reacts to sightings, casualties, and plants. Bots keep acting while it thinks.';
  $('opponentReason').textContent = s?.status === 'thinking' ? `Replanning: ${s.planningReason}`
    : s?.status === 'fallback' ? '' : s?.reason ? `Why this plan: ${s.reason}` : '';
  $('opponentSummary').textContent = s?.error || (s?.summary
    ? `${s.status === 'thinking' ? 'Current plan: ' : ''}${s.summary}`
    : 'Waiting for the first plan. Defenders use their normal tactics in the meantime.');
  if ($('opponentDetails').open) {
    $('opponentOrders').replaceChildren(...(s?.orders ?? []).map(order => {
      const unit = game.units.find(u => u.id === order.unitId);
      const escape = unit?.botFallback;
      const reflex = escape ? `taking cover (${escape.allies} vs ${escape.enemies}) · ` : '';
      return el('div', {
        className: 'order',
        textContent: `${unit?.name ?? order.unitId}: ${unit?.alive ? `${reflex}${order.action} → ${order.zone}` : 'eliminated'}`,
      });
    }));
  }
}

// Kill-feed lines name agents, so each name is drawn in that agent's own colour.
function colorizeNames(text) {
  const colors = new Map();
  for (const u of [...(view.units ?? []), ...(view.roster ?? [])]) if (u.color) colors.set(u.name, u.color);
  const names = [...colors.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return [text];
  const parts = text.split(new RegExp(`\\b(${names.join('|')})\\b`, 'g'));
  return parts.map(part => (colors.has(part)
    ? el('b', { textContent: part, style: `color:${colors.get(part)}` })
    : part));
}

// Who an agent is shooting at, when Jev picked a target.
function enemyName(u) {
  const target = u.decision?.target;
  return target && view.units.some(e => e.name === target) ? target : null;
}

function updateHud() {
  if (!session || !view) return;
  const seconds = Math.max(0, Math.ceil(view.status.clock));
  $('scoreClock').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  updateTitle();
  $('roundLabel').textContent = view.status.label;
  updateOpponentHud();

  const s = session.kind === 'bots' ? brains.summary() : online?.jev;
  if (s) {
    $('jevStats').replaceChildren(
      'Jev ', el('b', { textContent: `${s.perMinute}/min` }),
      ' · p50 ', el('b', { textContent: s.p50 ? `${s.p50} ms` : '–' }),
      ` · ${s.ok} ok · ${s.failed} failed`,
    );
    $('jevStats').title = s.lastError;
  }

  const own = view.units.filter(u => u.team === session.team);
  own.forEach((u, i) => {
    const card = $('squad').children[i];
    if (!card) return;
    card.classList.toggle('dead', !u.alive);
    card.classList.toggle('watched', u.id === watchedId);
    card.querySelector('.name').textContent = u.name;
    card.querySelector('.hp i').style.width = `${(u.hp / u.maxHp) * 100}%`;
    card.querySelector('.doing').textContent = actionLabel(u, enemyName(u));
    card.querySelector('.order').textContent = u.alive ? `Order: ${u.orderLabel}` : '';
    card.querySelector('.brain').textContent = !u.alive ? '' : !u.decision ? '…'
      : u.decision.local ? 'no contact' : `Jev ${Math.round(u.decision.latency)} ms`;
    // Just the chosen action's confidence: the full spread was more noise than signal.
    const [action, p] = (u.alive ? Object.entries(u.decision?.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0] : null) ?? [];
    card.querySelector('.probs').replaceChildren(...(action ? [
      el('div', { className: 'prob top' }, [
        el('span', { textContent: action }),
        el('span', { className: 'bar' }, [el('i', { style: `width:${p * 100}%` })]),
        el('span', { textContent: `${Math.round(p * 100)}%` }),
      ]),
    ] : []));
  });

  $('feed').replaceChildren(...view.feed.map(f =>
    el('div', { className: f.team === session.team ? 'own' : 'other' }, colorizeNames(f.text))));

  updateScorebar();
  const watching = watched();
  if (watching) {
    $('povHp').textContent = Math.round(watching.hp);
    $('povName').textContent = watching.name;
    $('povName').style.color = watching.color;
    $('povAction').textContent = `${actionLabel(watching, enemyName(watching))} · order: ${watching.orderLabel ?? '–'}`;
    $('povZone').textContent = zoneAt(MAPS.tactical, watching).name.toUpperCase();
  }
}

// ---------- inputs ----------

const voice = createVoice({
  onInterim: onInterimTranscript,
  onFinal: onFinalTranscript,
  onStatus: (text, kind) => setStatus('micStatus', text, kind),
  onLevel: level => { $('level').style.width = `${level * 100}%`; },
});

// Voice is hands-free: the mic turns on when a match starts and listens only during matches.
// Each sentence becomes an order when you pause. Muting keeps it off until you unmute.
let micMuted = false;
async function ensureMic() {
  if (voice.enabled || !window.isSecureContext) return;
  try {
    await voice.enable(keytermsFor(session?.team ?? 'attack'));
  } catch (error) {
    setStatus('micStatus', `Mic unavailable: ${error.message}`, 'error');
  }
}

function syncListening() {
  const inMatch = Boolean(session && view && !view.result);
  voice.setListening(inMatch && !micMuted);
  const label = !voice.enabled ? 'Mic off'
    : micMuted ? 'Muted'
    : inMatch ? 'Listening'
    : 'Mic on';
  if ($('listenLabel').textContent !== label) $('listenLabel').textContent = label;
  $('listen').classList.toggle('live', voice.listening);
  $('micBtn').textContent = !voice.enabled ? 'Mic on' : micMuted ? 'Unmute' : 'Mute';
}

async function toggleMic() {
  if (!voice.enabled) {
    micMuted = false;
    await ensureMic();
    saveDevices({ asked: true, mic: true });
    syncPerms();
  } else {
    micMuted = !micMuted;
  }
  syncListening();
}
$('micBtn').onclick = toggleMic;
$('listen').onclick = toggleMic;

$('textForm').onsubmit = e => {
  e.preventDefault();
  const text = $('textInput').value;
  $('textInput').value = '';
  $('textInput').blur();
  issueCommand({ source: 'text', text });
};

canvas.addEventListener('click', e => {
  const p = renderer.toWorld(e.clientX, e.clientY);
  if (p.x < 0 || p.y < 0 || p.x > 80 || p.y > 56) return;
  pointer = { ...p, at: performance.now() };
});

// No aiming in first-person: it's a view for watching one agent, not for marking spots.
povCanvas.addEventListener('click', () => showToast('Aim from the map view'));

const typing = () => document.activeElement?.tagName === 'INPUT';
document.addEventListener('keydown', e => {
  if (typing()) return;
  // Escape is the way back to the menu now that there's no header.
  if (e.code === 'Escape' && session && view && !view.result) {
    e.preventDefault();
    if (!$('screenSettings').hidden) showScreen(settingsFrom);
    else showScreen($('overlay').hidden ? 'screenPause' : null);
    return;
  }
  if (!matchActive()) return;
  if (e.code === 'Tab') {
    e.preventDefault();
    setView(!is3d);
  } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    cycleAgent(e.code === 'ArrowRight' ? 1 : -1);
  } else if (/^Digit[1-4]$/.test(e.code)) {
    const u = ownUnits()[Number(e.code.slice(5)) - 1];
    if (u?.alive) watchAgent(u);
  }
});

let gestures = null;
$('previewBtn').onclick = () => {
  const showing = $('cam').hidden;
  $('cam').hidden = !showing;
  $('previewBtn').textContent = showing ? 'Hide preview' : 'Show preview';
};
$('camBtn').onclick = async () => {
  const wanted = !gestures;
  if (wanted) await startCamera();
  else stopCamera();
  saveDevices({ asked: true, camera: wanted });
  syncPerms();
};

function stopCamera() {
  {
    gestures.stop();
    gestures = null;
    $('camBtn').textContent = 'Camera on';
    $('camOff').hidden = false;
    $('cam').hidden = true;
    $('previewBtn').hidden = true;
    $('sign').hidden = true;
    setStatus('camStatus', 'Camera off');
  }
}

async function startCamera() {
  if (gestures) return true;
  try {
    $('camOff').hidden = true;
    gestures = await createGestures({
      video: $('video'),
      overlay: $('hand'),
      onStatus: (text, kind) => setStatus('camStatus', text, kind),
      onPointer: (p, name) => {
        if (!signTimer) {
          const labels = { Pointing_Up: '☝️ Aiming', Thumb_Left: '👈 Previous agent', Thumb_Right: '👉 Next agent' };
          const label = labels[name] ?? (SIGNALS[name] ? `${SIGNALS[name].emoji} ${SIGNALS[name].label}…` : '');
          $('sign').hidden = name === 'None';
          $('sign').textContent = label;
        }
        if (!p || is3d || !matchActive()) return; // aiming is map-view only
        // Use the middle of the camera frame so you don't have to reach the edges.
        const nx = Math.min(1, Math.max(0, (p.x - 0.15) / 0.7));
        const ny = Math.min(1, Math.max(0, (p.y - 0.15) / 0.7));
        pointer = { x: nx * 80, y: ny * 56, at: performance.now() };
      },
      onSignal: handleSignal,
      onSwipe: dir => {
        if (!matchActive()) return;
        // Swiping drags the bar like a carousel: hand to the right brings the agent on the left.
        showSign(dir > 0 ? '👉 Previous agent' : '👈 Next agent');
        cycleAgent(-dir);
      },
      // A thumb out sideways picks the agent on that side; pinch still switches map/first-person.
      onPointDirection: dir => {
        if (matchActive()) cycleAgent(dir);
      },
      onPinch: () => {
        if (!matchActive()) return;
        showSign(is3d ? '🤏 Map' : '🤏 First-person');
        setView(!is3d);
      },
    });
    $('camBtn').textContent = 'Camera off';
    $('previewBtn').hidden = false;
    $('previewBtn').textContent = 'Hide preview';
    $('cam').hidden = false;
    return true;
  } catch (error) {
    $('camOff').hidden = false;
    setStatus('camStatus', `Camera unavailable: ${error.message}`, 'error');
    return false;
  }
}

let signTimer = null;
function showSign(text) {
  $('sign').hidden = false;
  $('sign').textContent = text;
  clearTimeout(signTimer);
  signTimer = setTimeout(() => { signTimer = null; }, 1200);
}

$('signs').replaceChildren(
  el('span', { textContent: '☝️ aim', title: 'Point straight up to mark a spot on the map' }),
  el('span', { textContent: '🫱 agent', title: 'Hold your thumb out left or right to keep stepping through the squad' }),
  el('span', { textContent: '🤏 view', title: 'Pinch to switch between the map and first-person' }),
  ...Object.entries(SIGNALS).map(([name, s]) => el('span', {
    textContent: `${s.emoji} ${name === 'ILoveYou' ? 'special' : s.label.toLowerCase()}`, title: s.meaning,
  })),
);

// Mic and camera need a secure page (HTTPS or localhost); typed orders and map clicks always work.
if (!window.isSecureContext) {
  const why = 'needs HTTPS or localhost. Type orders instead.';
  setStatus('micStatus', `Voice ${why}`, 'error');
  setStatus('camStatus', `Camera ${why}`, 'error');
  $('micBtn').disabled = true;
  $('listen').disabled = true;
  $('camBtn').disabled = true;
}

window.addEventListener('resize', () => setView(is3d));

function setStatus(id, text, kind = '') {
  $(id).textContent = text;
  $(id).className = `status ${kind}`;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  if (props.style) node.setAttribute('style', props.style);
  for (const child of [].concat(children)) node.append(child);
  return node;
}

renderer.resize();
const joinCode = new URLSearchParams(location.search).get('join');
if (joinCode) {
  $('joinCode').value = joinCode.toUpperCase();
  connectOnline(joinCode.toUpperCase());
} else {
  showScreen('screenMenu');
}
restoreDevices();
requestAnimationFrame(frame);

// Handy for debugging and scripted demos in the console.
window.commander = {
  get session() { return session; },
  get view() { return view; },
  get online() { return online && { code: online.code, team: online.team, host: online.host, players: online.players }; },
  get game() { return game; },
  issueCommand,
  signal: handleSignal,
  get is3d() { return is3d; },
  setView,
  cycleAgent,
  get utterances() { return [...utterances]; },
  setSpeculative: on => { speculateEnabled = on; },
  point: (x, y) => { pointer = { x, y, at: performance.now() }; },
  voice,
};
