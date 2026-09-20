// Commander (Spike Rush): voice, hand signals, and typed orders → Jev → four agents.
// Vs Bots runs the whole match in this tab. Multiplayer connects to a room on the server,
// which runs the match and streams this player their team's view.
import { createBrains } from './brain.js';
import { createOpponentCommander } from './opponent.js';
import { createCamera, createPovRenderer } from './pov.js';
import { SIGNALS, POINTER_ACTIVE_MS, POINTER_ORDER_TTL_MS, cameraToMapPoint,
  createGestures, reliableGestureForSpeech } from './gestures.js';
import { createRenderer } from './render.js';
import { MANUAL_AIM, OWN_COLORS, TEAMS, actionLabel, createGame, otherTeam, setManualAim, stepGame, teamView } from './sim.js';
import { createVoice } from './voice.js';
import { MAPS, zoneAt } from './world.js';

const STEP = 1 / 60;
const RECENT_GESTURE_MS = 2000;
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
let recentGesture = null;
let aim = null; // first-person mouse look; the agent always fires automatically
let lastAimSent = 0;
let lastAimEnded = -Infinity;
let lastCamera = null;

// ---------- view: the top-down map (default) or one agent's first-person view ----------

const ownUnits = () => (view?.units ?? []).filter(u => u.team === view.team);
const watched = () => ownUnits().find(u => u.id === watchedId && u.alive) ?? null;

function setView(next) {
  if (!next) stopAiming();
  is3d = next;
  $('arena').dataset.view = is3d ? 'pov' : 'map';
  $('hint').textContent = is3d
    ? 'Auto fire. Click for mouse look; keep the crosshair on an enemy for better accuracy. ←/→ or 1–4: switch. Tab: map.'
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
  if (u.id !== watchedId && aim) {
    aim = { unitId: u.id, yaw: u.facing, pitch: 0 };
    sendAim(); // only the newly watched agent can receive the crosshair bonus
  }
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

const activePointer = () => (pointer && performance.now() - pointer.at < POINTER_ORDER_TTL_MS ? pointer : null);

// ---------- screens ----------

function showScreen(name) {
  if (name) stopAiming();
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
  resetSpeech();
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

let botOpponent = 'openai';
let botSide = 'attack';
$('playBots').onclick = () => {
  setStatus('botsStatus', '');
  showScreen('screenBots');
};
$('botsScripted').onclick = () => startBotGame('scripted', $('botSide').value);
$('botsOpenAI').onclick = () => startBotGame('openai', $('botSide').value);
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
for (const team of ['attack', 'defend']) $(team === 'attack' ? 'hostAttack' : 'hostDefend').onclick = () =>
  online?.ws.send(JSON.stringify({ type: 'side', team }));
$('swapSides').onclick = () => online?.ws.send(JSON.stringify({ type: 'side', team: otherTeam(session.team) }));

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

function startBotGame(opponent = botOpponent, playerTeam = botSide) {
  leaveOnline();
  botOpponent = opponent;
  botSide = playerTeam;
  opponentCommander.reset();
  session = { kind: 'bots', team: playerTeam };
  game = createGame({ defenders: 'bots', opponent, playerTeam });
  brains = createBrains();
  view = teamView(game, playerTeam);
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
      connection.running = message.running;
      renderLobby();
      if (resultShown) updateResultActions();
      break;
    case 'sides':
      resetSpeech();
      connection.team = message.team;
      session = { kind: 'online', team: message.team };
      view = null;
      resultShown = false;
      for (const { reject } of connection.pending.values()) reject(new Error('Sides changed'));
      connection.pending.clear();
      updateTeamUi();
      renderLobby();
      showScreen('screenLobby');
      break;
    case 'started':
      connection.running = true;
      view = null;
      beginMatch();
      break;
    case 'state':
      view = message.view;
      if (view.result) connection.running = false;
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
  $('hostSideControls').hidden = !host;
  for (const side of ['attack', 'defend']) {
    const button = $(side === 'attack' ? 'hostAttack' : 'hostDefend');
    button.setAttribute('aria-pressed', String(team === side));
    button.disabled = Boolean(online.running);
  }
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
  stopAiming();
  if (!online) return;
  const { ws } = online;
  online = null;
  ws.close();
}

// ---------- matches ----------

function beginMatch() {
  stopAiming();
  lastCamera = null;
  resetSpeech();
  if (readDevices().mic !== false) ensureMic();
  pov.reset();
  clearTimeout(speculateTimer);
  guess = null;
  utterance = null;
  resultShown = false;
  positions.clear();
  recentGesture = null;
  $('log').replaceChildren();
  $('voiceSummary').textContent = 'Volume: — · Emphasis: —';
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
  resetSpeech();
  resultShown = true;
  const won = view.result.winner === session.team;
  $('resultTitle').textContent = won ? 'Victory' : 'Defeat';
  $('resultTitle').className = won ? 'win' : 'lose';
  $('resultText').textContent = view.result.reason;
  updateResultActions();
  showScreen('screenResult');
}

function updateResultActions() {
  $('swapSides').hidden = session.kind !== 'online' || !online?.host || !opponentPresent();
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

// Partial transcripts let the squad begin moving before the commander finishes speaking.
// The final transcript is evaluated with completed voice metrics, and a sequence prevents
// an older guess from overwriting its correction.
const SPECULATE_AFTER_MS = 120;
const SPECULATE_MIN_WORDS = 3;
let guess = null;
let speculateTimer = null;
let speculateEnabled = true;
let commandSeq = 0;
let speechEpoch = 0;
// One record per spoken utterance, for measuring how quickly the squad reacts.
let utterance = null;
const utterances = [];
const sameWords = (a, b) => a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() ===
  b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

function voiceLabels(context) {
  return [
    `Volume: ${context.volumeLevel.replaceAll('_', ' ')}`,
    `Emphasis: ${context.emphasisLevel}`,
    `Rate: ${context.speechRate}`,
    ...(context.profanityLevel && context.profanityLevel !== 'none'
      ? [`Profanity cue: ${context.profanityLevel}`] : []),
  ];
}

function gestureLabel(gesture) {
  return `Gesture: ${gesture.label} · ${gesture.context.confidenceLevel} confidence · ${Math.round(gesture.context.stability * 100)}% stable`;
}

const canCommand = () => matchActive();
const commandTarget = () => (is3d ? watched()?.name : undefined);
const interpret = request => (session.kind === 'bots'
  ? brains.interpretCommand(game, session.team, request)
  : sendCommand(request));

function recentReliableGesture() {
  if (!recentGesture || performance.now() - recentGesture.at >= RECENT_GESTURE_MS) return null;
  const gesture = { ...recentGesture.gesture, context: {
    ...recentGesture.gesture.context,
    ageMs: Math.round(performance.now() - recentGesture.at),
  } };
  return reliableGestureForSpeech(gesture) ? gesture : null;
}

function prepareCommand({ source = 'text', text, gesture, voiceContext, seq = ++commandSeq, only = commandTarget() }) {
  const commandGesture = gesture ?? (source === 'hand' ? null : recentReliableGesture());
  const p = activePointer();
  return {
    source, text, gesture: commandGesture, voiceContext, seq, only,
    pointer: p && { x: p.x, y: p.y },
  };
}

async function runCommand(entry, request, { early = false, current = () => true } = {}) {
  try {
    const result = await interpret(request);
    if (current()) renderPlan(entry, result, request.voiceContext, request.gesture, early);
    return result;
  } catch (error) {
    if (current()) showEntryError(entry, error);
    return null;
  }
}

async function issueCommand(input) {
  if (!input.text?.trim()) return;
  if (!canCommand()) {
    setStatus('micStatus', 'Start a match first.', 'error');
    return;
  }
  const request = prepareCommand(input);
  const label = request.only ? `→ ${request.only}: ${request.text}` : request.text;
  const entry = addLogEntry(request.source, label, request.gesture, request.voiceContext);
  return runCommand(entry, request);
}

function resetSpeech() {
  speechEpoch++;
  clearTimeout(speculateTimer);
  if (guess) guess.stale = true;
  guess = null;
  utterance = null;
}

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
  if (!canCommand() || guess?.promise) return; // one guess in flight, within the current match
  if (guess) guess.stale = true;
  const request = prepareCommand({ source: 'voice', text });
  const entry = guess?.entry ?? addLogEntry('voice', text, request.gesture, null, true);
  setEntryText(entry, text, true);
  const g = { text, entry, promise: null, applied: false, stale: false,
    epoch: speechEpoch, only: request.only, pointer: request.pointer };
  guess = g;
  g.promise = runCommand(entry, request, { early: true, current: () => !g.stale && g.epoch === speechEpoch })
    .then(result => {
      g.applied = Boolean(result && !result.ignored && !result.stale && result.plan?.some(p => p.applied));
      // the first moment the squad moved on this utterance
      if (g.applied && utterance) utterance.actedAt ||= performance.now();
    })
    .finally(() => { g.promise = null; });
}

async function onFinalTranscript(text, voiceContext) {
  clearTimeout(speculateTimer);
  if (!canCommand()) { resetSpeech(); return; }
  const epoch = speechEpoch;
  $('caption').textContent = text;
  $('voiceSummary').textContent = voiceContext
    ? voiceLabels(voiceContext).filter(label => !label.startsWith('Rate:')).join(' · ')
    : 'Volume: — · Emphasis: —';
  const u = utterance ?? { heardAt: performance.now(), actedAt: 0 };
  utterance = null;
  u.finalAt = performance.now();
  const g = guess;
  guess = null;
  const pointer = activePointer();
  const reusedGuess = Boolean(g && sameWords(g.text, text) && g.only === commandTarget()
    && g.pointer?.x === pointer?.x && g.pointer?.y === pointer?.y);
  if (g) g.stale = true; // its orders must not overwrite the finished sentence's
  if (epoch !== speechEpoch || !canCommand()) return;
  let result;
  if (g) {
    const request = prepareCommand({ source: 'voice', text, voiceContext });
    setEntryText(g.entry, text, false);
    result = await runCommand(g.entry, request);
  } else {
    result = await issueCommand({ source: 'voice', text, voiceContext });
  }
  u.settledAt = performance.now();
  if (!u.actedAt && result && !result.ignored && !result.stale && result.plan?.some(p => p.applied)) {
    u.actedAt = u.settledAt;
  }
  utterances.push({
    text, speculated: Boolean(u.actedAt && u.actedAt < u.finalAt), reusedGuess,
    actedAfterMs: Math.round((u.actedAt || u.settledAt) - u.heardAt),
    settledAfterMs: Math.round(u.settledAt - u.heardAt),
    afterYouStopMs: Math.round(u.settledAt - u.finalAt),
  });
  if (utterances.length > 20) utterances.shift();
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

function showEntryError(entry, error) {
  entry.querySelector('.plan').replaceChildren();
  entry.querySelector('.meta').replaceChildren(el('span', { className: 'err', textContent: `Jev failed: ${error.message}` }));
}

function setEntryText(entry, text, early) {
  const said = entry.querySelector('.said');
  said.replaceChildren(el('span', { className: 'src', textContent: said.querySelector('.src').textContent }), text);
  entry.classList.toggle('early', early);
}

function addLogEntry(source, text, gesture, voiceContext, early = false) {
  const icon = { voice: 'Voice', text: 'Typed', hand: gesture?.emoji ?? 'Sign' }[source];
  const details = [
    ...(voiceContext ? voiceLabels(voiceContext) : []),
    ...(gesture?.context ? [gestureLabel(gesture)] : []),
  ];
  const entry = el('div', { className: `entry${early ? ' early' : ''}` }, [
    el('div', { className: 'said' }, [el('span', { className: 'src', textContent: icon }), text]),
    el('div', { className: 'plan', textContent: 'Jev is reading the order…' }),
    el('div', { className: 'meta' }),
    el('div', { className: 'ux', hidden: !details.length },
      details.map(detail => el('span', { textContent: detail }))),
  ]);
  $('log').prepend(entry);
  return entry;
}

function renderPlan(entry, { plan, latency, tokens, ignored, isOrder, stale, ux, paceMultiplier }, voiceContext, gesture, early = false) {
  const pct = v => `${Math.round(v * 100)}%`;
  if (stale) {
    entry.querySelector('.plan').replaceChildren(el('span', { className: 'skip', textContent: 'Superseded by a newer order' }));
    entry.classList.add('ignored');
    return;
  }
  if (voiceContext && ux) {
    const details = [
      `Urgency: ${ux.urgency}`,
      `Certainty: ${ux.certainty}`,
      ...voiceLabels(voiceContext),
      ...(paceMultiplier > 1 && !ignored ? [`Movement pace: ${Math.round(paceMultiplier * 100)}%`] : []),
      ...(gesture?.context ? [gestureLabel(gesture)] : []),
    ];
    entry.querySelector('.ux').replaceChildren(...details.map(detail => el('span', { textContent: detail })));
    entry.querySelector('.ux').hidden = false;
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
        el('span', { className: 'skip', textContent: p.skipReason ?? 'not addressed' }),
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
const matchActive = () => Boolean(session && view && !view.result && $('overlay').hidden);

function handleSignal(signal) {
  if (!matchActive()) return;
  const name = typeof signal === 'string' ? signal : signal.name;
  if (!Object.hasOwn(SIGNALS, name)) return;
  if (is3d && SQUAD_ONLY_SIGNALS[name]) {
    showSign(`${SQUAD_ONLY_SIGNALS[name]}: map view only`);
    return;
  }
  const p = activePointer();
  const { text: said, gesture } = signalOrder(name, session.team, Boolean(p));
  const u = is3d ? watched() : null;
  const text = u ? said.replace(/^Everyone/, u.name) : said;
  if (typeof signal !== 'string') {
    const pointerAgeMs = p ? performance.now() - p.at : Infinity;
    gesture.context = {
      name, meaning: gesture.meaning,
      confidence: signal.confidence, stability: signal.stability, heldMs: signal.heldMs,
      confidenceLevel: signal.confidenceLevel, stabilityLevel: signal.stabilityLevel,
      pointer: p ? {
        active: signal.pointer?.active ?? pointerAgeMs < POINTER_ACTIVE_MS,
        zone: zoneAt(MAPS.tactical, p).name,
        ageMs: Math.round(pointerAgeMs),
      } : null,
      ageMs: 0,
    };
    recentGesture = { gesture, at: performance.now() };
  }
  showSign(`✓ ${gesture.emoji} ${gesture.label}`);
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
  if (aim) {
    if (!matchActive() || !is3d) stopAiming();
    else if (session.kind === 'bots' || now - lastAimSent >= 50) sendAim();
  }
  if (session?.kind === 'bots' && game) {
    if (!game.result && !paused()) {
      accumulator += dt;
      while (accumulator >= STEP) {
        stepGame(game, STEP);
        accumulator -= STEP;
      }
      brains.update(game, session.team);
      opponentCommander.update(game);
    }
    view = teamView(game, session.team);
  }
  if (session?.kind === 'online') smoothPositions(dt);
  const smoothed = session?.kind === 'online' ? positions : null;
  if (is3d && !watched()) cycleAgent(1); // the agent you were watching died
  const u = is3d ? watched() : null;
  if (u) {
    const at = unit => smoothed?.get(unit.id) ?? unit;
    pov.setPointer(activePointer());
    lastCamera = camera.update({ ...u, ...at(u) }, dt, aim);
    pov.draw(view, u, lastCamera, at);
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
    ? `${TEAMS[session.team].label} · ${session.kind === 'online' ? online?.code ?? 'online' : `vs bots · ${botOpponent === 'openai' ? 'Hard' : 'Easy'}`}`
    : 'Menu';
  const title = `Commander — ${where}`;
  if (document.title !== title) document.title = title;
}

function updateTeamUi() {
  const team = session?.team;
  // The card keeps its place between matches; only what it says changes.
  $('teamBadge').className = `badge ${team ?? ''}`;
  $('teamBadge').textContent = team
    ? `${TEAMS[team].label}${session.kind === 'online' ? ` · ${online?.code ?? ''}` : ` · ${botOpponent === 'openai' ? 'Hard' : 'Easy'} bots`}`
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
  // A multiplayer match starts before its first snapshot arrives, so there is nobody to show
  // yet. updateScorebar builds the bar as soon as one does.
  if (!view) {
    scorebarKey = '';
    $('squadBar').replaceChildren();
    $('enemyBar').replaceChildren();
    return;
  }
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
  $('enemyBar').replaceChildren(...(view?.roster ?? []).map(u => portrait(u)));
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
    fallback: 'unavailable · scripted tactics',
  };
  const text = game.result ? 'round finished' : labels[s?.status] ?? 'starting…';
  setStatus('opponentStatus', text, s?.status === 'fallback' ? 'error' : '');
  $('opponentStatus').title = s?.error || 'The enemy commander reacts to sightings, casualties, grenades, and plants. Bots keep acting while it thinks.';
  $('opponentReason').textContent = s?.status === 'thinking' ? `Replanning: ${s.planningReason}`
    : s?.status === 'fallback' ? '' : s?.reason ? `Why this plan: ${s.reason}` : '';
  $('opponentSummary').textContent = s?.error || (s?.summary
    ? `${s.status === 'thinking' ? 'Current plan: ' : ''}${s.summary}`
    : 'Waiting for the first plan. Bots use their normal tactics in the meantime.');
  const group = game.botRetake;
  $('opponentCoordination').textContent = !group ? '' : group.phase === 'gathering'
    ? `Gathering at ${group.zone}: ${group.ready}/${group.required} ready`
    : `Retaking ${group.site} · ${group.reason}`;
  if ($('opponentDetails').open) {
    $('opponentOrders').replaceChildren(...(s?.orders ?? []).map(order => {
      const unit = game.units.find(u => u.id === order.unitId);
      const escape = unit?.botFallback;
      const reflex = unit?.botDodge ? 'dodging grenade · '
        : escape ? `taking cover (${escape.allies} vs ${escape.enemies}) · ` : '';
      return el('div', {
        className: 'order',
        textContent: `${unit?.name ?? order.unitId}: ${unit?.alive ? `${reflex}${order.action} → ${order.zone} · ${unit.grenades} grenade${unit.grenades === 1 ? '' : 's'} left` : 'eliminated'}`,
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
    card.querySelector('.order').textContent = u.alive ? `Order: ${u.orderLabel}${u.grenades ? ' · 💣' : ''}` : '';
    card.querySelector('.brain').textContent = !u.alive ? ''
      : u.decision?.obeying ? 'following your order'
      : !u.decision ? 'thinking…'
      : u.decision.local ? 'no contact: following order' : `Jev ${Math.round(u.decision.latency)} ms`;
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
    $('povHp').title = `${Math.round(watching.hp)} / ${watching.maxHp} HP`;
    $('povControl').textContent = aim
      ? `AUTO FIRE · ${watching.aimTargetId ? 'Aim bonus active' : 'Aim at an enemy for better accuracy'} · Esc releases cursor`
      : 'AUTO FIRE · Click for mouse look · Aim at an enemy for better accuracy';
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

// Hands-free is the multiplayer default; hold-to-talk preserves the previous V-key control.
let micMuted = false;
let voiceMode = 'handsfree';
let pttHeld = false;
let micEnabling = null;
async function ensureMic() {
  if (!window.isSecureContext) {
    setStatus('micStatus', 'Voice needs HTTPS or localhost.', 'error');
    return;
  }
  if (micEnabling) return micEnabling;
  if (voice.enabled) return;
  micEnabling = voice.enable(keytermsFor(session?.team ?? 'attack'))
    .catch(error => setStatus('micStatus', `Mic unavailable: ${error.message}`, 'error'))
    .finally(() => { micEnabling = null; });
  return micEnabling;
}

function syncListening() {
  const inMatch = matchActive();
  const shouldListen = inMatch && !micMuted && (voiceMode === 'handsfree' || pttHeld);
  if (voiceMode === 'ptt' && shouldListen && !voice.listening) voice.startTalking();
  else if (voiceMode === 'ptt' && !shouldListen && voice.listening) voice.stopTalking();
  else if (voiceMode === 'handsfree') voice.setListening(shouldListen);
  const label = !voice.enabled ? '🎙 Mic off'
    : micMuted ? '🔇 Muted: click to unmute'
    : !inMatch ? '🎙 Mic on: listens during matches'
      : voiceMode === 'ptt' ? pttHeld ? '🎙 Listening: release to send' : '🎙 Hold V or this button to talk'
        : '🎙 Listening: just talk';
  if ($('listenLabel').textContent !== label) $('listenLabel').textContent = label;
  $('listen').classList.toggle('live', voice.listening);
  $('listen').title = voiceMode === 'ptt' ? 'Hold to talk' : 'Click to mute or unmute';
  $('voiceMode').textContent = voiceMode === 'ptt' ? 'Hold to talk' : 'Hands-free';
  $('voiceMode').setAttribute('aria-pressed', String(voiceMode === 'ptt'));
  $('micBtn').textContent = !voice.enabled ? 'Turn on mic' : micMuted ? 'Unmute' : 'Mute';
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
$('voiceMode').onclick = () => {
  pttHeld = false;
  voiceMode = voiceMode === 'handsfree' ? 'ptt' : 'handsfree';
  syncListening();
};
$('listen').onclick = () => { if (voiceMode === 'handsfree') toggleMic(); };
$('listen').addEventListener('pointerdown', () => {
  if (voiceMode !== 'ptt') return;
  pttHeld = true;
  if (!voice.enabled) ensureMic().then(syncListening);
  syncListening();
});
function releaseToTalk() {
  if (!pttHeld) return;
  pttHeld = false;
  syncListening();
}
for (const event of ['pointerup', 'pointercancel', 'pointerleave']) $('listen').addEventListener(event, releaseToTalk);
document.addEventListener('keydown', e => {
  if (voiceMode !== 'ptt' || e.code !== 'KeyV' || e.repeat || document.activeElement?.tagName === 'INPUT') return;
  e.preventDefault();
  pttHeld = true;
  if (!voice.enabled) ensureMic().then(syncListening);
  syncListening();
});
document.addEventListener('keyup', e => { if (e.code === 'KeyV') releaseToTalk(); });
window.addEventListener('blur', releaseToTalk);

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

// Pointer lock gives mouse aiming without hitting the edges of the canvas. We transmit
// camera direction at 20 Hz; the shared simulation owns automatic shots and accuracy.
function sendAim() {
  if (!session) return;
  lastAimSent = performance.now();
  if (session.kind === 'bots' && game) setManualAim(game, session.team, aim);
  else if (online?.ws.readyState === WebSocket.OPEN) online.ws.send(JSON.stringify({ type: 'aim', aim }));
}

function stopAiming() {
  if (aim) {
    aim = null;
    lastAimEnded = performance.now();
    sendAim();
  }
  if (document.pointerLockElement === povCanvas) document.exitPointerLock();
}

povCanvas.addEventListener('mousedown', async e => {
  if (e.button !== 0 || !matchActive() || !is3d || !watched()) return;
  e.preventDefault();
  if (aim) return;
  try {
    await povCanvas.requestPointerLock();
  } catch {
    showToast('Click again to aim; your agent is still firing automatically.');
  }
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== povCanvas) { stopAiming(); return; }
  const u = watched();
  if (!matchActive() || !is3d || !u) { stopAiming(); return; }
  document.activeElement?.blur();
  aim = { unitId: u.id, yaw: lastCamera?.unitId === u.id ? lastCamera.angle : u.facing, pitch: 0 };
  sendAim();
});
document.addEventListener('mousemove', e => {
  if (!aim || document.pointerLockElement !== povCanvas) return;
  aim.yaw = Math.atan2(Math.sin(aim.yaw + e.movementX * 0.002), Math.cos(aim.yaw + e.movementX * 0.002));
  aim.pitch = Math.max(-MANUAL_AIM.maxPitch, Math.min(MANUAL_AIM.maxPitch, aim.pitch - e.movementY * 0.002));
});
window.addEventListener('blur', stopAiming);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAiming(); });

const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
document.addEventListener('keydown', e => {
  if (typing()) return;
  if (e.code === 'Escape' && (aim || performance.now() - lastAimEnded < 250)) {
    stopAiming();
    return;
  }
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
let gestureFeedback = { stage: 'none', name: null };

function renderGestureFeedback({ stage, name }) {
  const sign = $('sign');
  if (stage === 'none') { sign.hidden = true; return; }
  sign.hidden = false;
  if (stage === 'pointing') { sign.textContent = '☝️ Aiming'; return; }
  const signal = SIGNALS[name];
  sign.textContent = stage === 'confirmed' ? `✓ ${signal.emoji} ${signal.label}`
    : stage === 'stabilizing' ? `${signal.emoji} ${signal.label}…`
      : `${signal.emoji} ${signal.label} detected`;
}

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
  if (!gestures) return;
  gestures.stop();
  gestures = null;
  recentGesture = null;
  gestureFeedback = { stage: 'none', name: null };
  clearTimeout(signTimer);
  signTimer = null;
  $('camBtn').textContent = 'Camera on';
  $('camOff').hidden = false;
  $('cam').hidden = true;
  $('previewBtn').hidden = true;
  $('sign').hidden = true;
  setStatus('camStatus', 'Camera off');
}

async function startCamera() {
  if (gestures) return true;
  $('camBtn').disabled = true;
  try {
    $('camOff').hidden = true;
    gestures = await createGestures({
      video: $('video'),
      overlay: $('hand'),
      onStatus: (text, kind) => setStatus('camStatus', text, kind),
      onFeedback: feedback => {
        gestureFeedback = feedback;
        if (!signTimer) renderGestureFeedback(feedback);
      },
      onPointer: p => {
        if (!p || is3d || !matchActive()) return;
        // Use the middle of the camera frame so you don't have to reach the edges.
        pointer = { ...cameraToMapPoint(p, MAPS.tactical), at: performance.now() };
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
    gestureFeedback = { stage: 'none', name: null };
    renderGestureFeedback(gestureFeedback);
    setStatus('camStatus', `Camera unavailable: ${error.message}`, 'error');
    return false;
  } finally {
    $('camBtn').disabled = false;
  }
}

let signTimer = null;
function showSign(text) {
  $('sign').hidden = false;
  $('sign').textContent = text;
  clearTimeout(signTimer);
  signTimer = setTimeout(() => { signTimer = null; renderGestureFeedback(gestureFeedback); }, 1200);
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
  $('voiceMode').disabled = true;
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
  get gestures() { return gestures; },
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
