// Commander (Spike Rush): voice, hand signals, and typed orders → Jev → five agents.
// Vs Bots runs the whole match in this tab. Multiplayer connects to a room on the server,
// which runs the match and streams this player their team's view.
import { createBrains } from './brain.js';
import { createOpponentCommander } from './opponent.js';
import { createCamera, createPovRenderer } from './pov.js';
import { SIGNALS, POINTER_ACTIVE_MS, POINTER_ORDER_TTL_MS, cameraToMapPoint,
  createGestures, reliableGestureForSpeech } from './gestures.js';
import { createRenderer, flipPoint, flippedFor } from './render.js';
import { ENEMY_COLORS, MANUAL_AIM, OWN_COLORS, TEAMS, actionLabel, createGame, createMatch,
  otherTeam, setManualAim, stepGame, teamView } from './sim.js';
import { createVoice } from './voice.js';
import { MAPS, zoneAt } from './world.js';

const STEP = 1 / 60;
const RECENT_GESTURE_MS = 2000;
const $ = id => document.getElementById(id);

// The words the squad is most likely to hear. The ones that used to be hand signals are in
// here too, now that the only way to give those orders is to say them.
const ORDER_TERMS = ['spike', 'flank', 'regroup', 'rotate', 'push', 'hold', 'fall back', 'split',
  'grenade', 'nade', 'camp', 'lurk', 'peek'];
// Ways of addressing the whole squad. Keyterms as much as the callouts are: "everyone" heard
// as "every one", or "guys" dropped as filler, turns a squad order into chatter.
const SQUAD_TERMS = ['everyone', 'everybody', 'guys'];
// Whichever map is being played. The view carries its id, so zone lookups, callouts and the
// hand-to-map mapping all follow the match instead of assuming the default layout.
const currentMap = () => MAPS[view?.mapId] ?? MAPS.tactical;
// Callouts differ per map, so the speech hints come from whichever one is being played.
const keytermsFor = team => [
  ...TEAMS[team].names,
  ...currentMap().zones.map(z => z.name),
  ...ORDER_TERMS, ...SQUAD_TERMS, team === 'attack' ? 'plant' : 'defuse',
];

// What each hand signal says. The words go to Jev like any other order.
function signalOrder(name, team, pointed) {
  const attack = team === 'attack';
  const [a, b, c, d, e] = TEAMS[team].names;
  const carrier = view?.units.find(u => u.carrying)?.name ?? a;
  const orders = {
    Thumb_Up: pointed ? 'Everyone push there!' : 'Everyone push forward!',
    Open_Palm: 'Everyone hold your positions!',
    Closed_Fist: 'Everyone regroup!',
    Thumb_Down: attack ? 'Everyone fall back to spawn!' : 'Everyone fall back to Defender Spawn!',
    Victory: attack
      ? `${a}, ${b} and ${c} push A Site. ${d} and ${e} push B Site.`
      : `${a}, ${b} and ${c} hold A Site. ${d} and ${e} hold B Site.`,
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
const pov3dCanvas = $('pov3d');
// Only one first-person canvas is visible at a time, so mouse look has to follow the active
// engine: clicks land on whichever is on screen, and pointer lock may be held by either.
const aimSurfaces = [povCanvas, pov3dCanvas];
const lockedForAim = () => aimSurfaces.includes(document.pointerLockElement);
const pov = createPovRenderer(povCanvas);
const minimap = createRenderer($('minimap'));
const camera = createCamera();
// Two first-person engines behind one interface: the WebGL one by default, the raycaster as a
// fallback. Built on first use so a machine without WebGL still reaches the menu.
//
// pov3d is loaded on its own rather than imported, because it pulls in three.js: a static
// import makes the whole page depend on it, and a browser that cannot resolve one module in
// the graph runs none of them — the menu would render with every button dead. Loading it
// separately means a missing dependency, or a machine with no WebGL, costs the 3D view and
// nothing else. It also keeps three.js off the path to the menu.
let pov3d = null;
let pov3dFailed = false;
let createPov3dRenderer = null;
const using3d = () => use3d && !pov3dFailed && Boolean(createPov3dRenderer);
import('./pov3d.js')
  .then(module => {
    createPov3dRenderer = module.createPov3dRenderer;
    if (session) setView(is3d); // the arena can show the WebGL canvas now that there is one
  })
  .catch(error => dropTo2d(`it could not be loaded (${error.message})`));
// Leaving the 3D view for the raycaster, whether it never started or the GPU took its context
// away mid-round. Announced either way: the arena hides whichever canvas the engine isn't
// using, so a silent switch would leave the raycaster drawing into a hidden element.
function dropTo2d(reason) {
  if (pov3dFailed) return;
  pov3dFailed = true;
  if (reason) console.warn(`3D view unavailable, falling back to the raycaster: ${reason}`);
  if (session) {
    setView(is3d);
    if (is3d) showToast('3D view stopped — switched to 2D');
  }
}

function engine() {
  if (!using3d()) return pov;
  if (!pov3d) {
    try {
      pov3d = createPov3dRenderer($('pov3d'), $('pov3dHud'), { onLost: dropTo2d });
    } catch (err) {
      dropTo2d(err.message);
      return pov;
    }
  }
  return pov3d;
}
const opponentCommander = createOpponentCommander();

let session = null; // { kind: 'bots' | 'online', team }
let game = null; // bot games only: the local simulation
let brains = null; // bot games only: the attackers' Jev brains
let online = null; // multiplayer connection: { ws, code, team, host, players, pending, seq, jev }
let view = null; // what's on screen: a teamView, local or streamed from the server
let pointer = null; // { x, y, at } marked by clicking the map or pointing at the camera
let resultShown = false;
let is3d = false; // first-person view of one agent, instead of the top-down map
let use3d = true; // which first-person engine: WebGL (default) or the flat raycaster
let watchedId = null; // which agent that is
const positions = new Map(); // smoothed unit positions for multiplayer
let recentGesture = null;
let aim = null; // first-person look, from the mouse or a raised fist; the agent fires by itself
let aimSource = null; // 'mouse' | 'hand'
let handAim = null; // the smoothed centre of your fist, from the camera: { x, y, at }
let handYaw = 0; // where the middle of the frame points, which holding a fist at an edge turns
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
  $('arena').dataset.engine = using3d() ? '3d' : 'classic';
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

const MENU_NOTE = 'Command five agents by voice and hand signal.';

function showScreen(name) {
  if (name) stopAiming();
  $('overlay').hidden = !name;
  for (const id of ['screenMenu', 'screenBots', 'screenOnline', 'screenLobby', 'screenPause', 'screenSettings', 'screenResult']) {
    $(id).hidden = id !== name;
  }
  // Keyboard users land on the thing they most likely want: the primary action if it's
  // available, else the first thing they can use. Closing hands focus back to the page.
  const screen = name && $(name);
  // One heading, always in the same place. The result screen writes its own, because it says
  // what happened rather than which screen this is.
  if (screen && screen.dataset.title) {
    $('screenTitle').textContent = screen.dataset.title;
    $('screenTitle').className = '';
  }
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
let botMap = 'tactical';
$('playBots').onclick = () => {
  setStatus('botsStatus', '');
  showScreen('screenBots');
};
$('botsScripted').onclick = () => startBotGame('scripted', botSide, botMap);
$('botsOpenAI').onclick = () => startBotGame('openai', botSide, botMap);

// A row of buttons standing in for a dropdown: every option visible, one click to change it.
// `pick` is called with the chosen value, and re-rendering is just calling this again.
function segment(id, options, selected, pick) {
  $(id).replaceChildren(...options.map(o => {
    const button = el('button', { type: 'button', textContent: o.label, title: o.title ?? '' });
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(o.value === selected));
    button.onclick = () => pick(o.value);
    return button;
  }));
}

const MAP_OPTIONS = Object.values(MAPS).map(m => ({ value: m.id, label: m.label, title: m.blurb }));
const SIDE_OPTIONS = [
  { value: 'attack', label: 'Attack', title: 'Plant the spike on one of the two sites' },
  { value: 'defend', label: 'Defend', title: 'Stop the plant, or defuse it' },
];

function drawBotPickers() {
  segment('botSide', SIDE_OPTIONS, botSide, value => {
    botSide = value;
    drawBotPickers();
  });
  segment('botMap', MAP_OPTIONS, botMap, value => {
    botMap = value;
    drawBotPickers();
  });
  // One line that follows the choice, instead of a suffix on every option in a closed list.
  $('botsHint').textContent = MAPS[botMap]?.blurb ?? '';
}
drawBotPickers();
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
  // Mid-match it starts the next round of the same best-of-three; afterwards, a new match.
  if (session?.kind === 'bots') {
    if (game?.match && !game.match.over) startBotRound(game.match);
    else startBotGame(botOpponent);
  } else if (online?.host && opponentPresent()) online.ws.send(JSON.stringify({ type: 'start' }));
  else if (online) showScreen('screenLobby');
};
const opponentPresent = () => Boolean(online?.players?.attack && online?.players?.defend);
$('startMatch').onclick = () => online?.ws.send(JSON.stringify({ type: 'start' }));
// Taking a side is clicking the seat you want. The guest's seats are disabled, so this only
// ever fires for the host.
for (const id of ['seatAttack', 'seatDefend']) $(id).onclick = () =>
  online?.ws.send(JSON.stringify({ type: 'side', team: $(id).dataset.side }));
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
  // Falls back to what the game is, rather than to an empty reserved line.
  $('menuNote').textContent = blocked ? 'Allow the mic and camera to play.' : MENU_NOTE;
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

function startBotGame(opponent = botOpponent, playerTeam = botSide, map = botMap) {
  leaveOnline();
  botOpponent = opponent;
  botSide = playerTeam;
  botMap = map;
  session = { kind: 'bots', team: playerTeam };
  brains = createBrains();
  startBotRound(createMatch({ playerTeam }));
}

// Each round of the match is a fresh game that keeps the match's score and scorecard. The
// brains carry over: their Jev counters are for the whole match.
function startBotRound(match) {
  opponentCommander.reset();
  game = createGame({ defenders: 'bots', opponent: botOpponent, playerTeam: session.team, match, prep: true, map: botMap });
  view = teamView(game, session.team);
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
      connection.map = message.map;
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
    case 'state': {
      const wasOver = view?.match?.over;
      view = message.view;
      if (view.result) connection.running = false;
      connection.jev = message.jev;
      if (resultShown && view.result && view.match?.over && !wasOver) showResult();
      break;
    }
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
  $('lobbyIntro').textContent = 'Share this code with your opponent.';
  // The guest sees which side and map they're about to play, but neither is theirs to change,
  // and nobody changes them once the match is under way.
  const locked = !host || Boolean(online.running);
  for (const [id, seat] of [['seatAttack', 'attack'], ['seatDefend', 'defend']]) {
    const filled = Boolean(players?.[seat]);
    const mine = seat === team;
    $(id).classList.toggle('filled', filled);
    $(id).classList.toggle('mine', mine);
    $(id).querySelector('.who').textContent = mine ? 'You' : filled ? 'Opponent' : 'Open';
    $(id).setAttribute('aria-pressed', String(mine));
    $(id).disabled = locked;
    $(id).title = locked ? '' : `Command the ${seat === 'attack' ? 'attackers' : 'defenders'}`;
  }
  const ready = Boolean(players?.attack && players?.defend);
  $('startMatch').hidden = !host;
  $('startMatch').disabled = !ready;
  segment('lobbyMap', MAP_OPTIONS, online.map ?? 'tactical', value =>
    online?.ws.send(JSON.stringify({ type: 'map', map: value })));
  for (const button of $('lobbyMap').children) button.disabled = locked;
  // The seats already say whether the other commander is here, so the host only needs a line
  // when they are waiting on somebody else to act — which, as host, they never are.
  setStatus('lobbyStatus', host ? '' : 'Waiting for the host to start the match…');
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
    ? 'Local link — run npm run online to share it.'
    : '';
  return `${origin}/commander/?join=${code}`;
}

$('copyInvite').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('inviteLink').value);
    $('inviteNote').textContent = 'Link copied.';
    // renderLobby puts back whatever the note should say, warning included.
    setTimeout(renderLobby, 1500);
  } catch {
    // Clipboard refused: show the link so it can be copied by hand.
    $('inviteLink').hidden = false;
    $('inviteLink').select();
    $('inviteNote').textContent = 'Press ⌘C to copy the link.';
  }
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
  pov3d?.reset();
  clearTimeout(speculateTimer);
  guess = null;
  utterance = null;
  resultShown = false;
  positions.clear();
  recentGesture = null;
  $('log').replaceChildren();
  $('feed').replaceChildren();
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
  const match = view.match;
  const won = (match?.over ? match.winner : view.result.winner) === session.team;
  const decided = match?.over ?? true;
  $('screenTitle').textContent = decided ? (won ? 'Victory' : 'Defeat') : won ? 'Round won' : 'Round lost';
  $('screenTitle').className = won ? 'win' : 'lose';
  $('resultText').textContent = match?.reason ?? view.result.reason;
  renderMatchScore(match);
  renderScoreboard(match);
  renderResultInsights(match);
  updateResultActions();
  showScreen('screenResult');
  $('overlay').scrollTop = 0;
}

// Both teams use the same score and table columns, from the player's perspective.
function renderMatchScore(match) {
  $('matchScore').hidden = !match;
  if (!match) return;
  const score = (team, mine) => el('div', { className: mine ? 'own' : 'them' }, [
    el('span', { className: 'score-label', textContent: mine ? 'Your squad' : 'Opponent' }),
    el('strong', { textContent: String(match.score[team]) }),
    el('span', { className: 'score-label', textContent: TEAMS[team].label }),
  ]);
  $('matchScore').replaceChildren(
    score(session.team, true),
    el('div', { className: 'of' }, [
      el('span', { textContent: match.over ? 'Match complete' : `Round ${match.round} complete` }),
      el('span', { textContent: `First to ${match.needed} · Best of ${match.bestOf}` }),
    ]),
    score(otherTeam(session.team), false),
  );
}

const SCORE_COLUMNS = [['Kills', r => r.kills], ['Deaths', r => r.deaths], ['Damage', r => r.damage]];
const scoreTotal = rows => rows.reduce((total, row) => ({
  kills: total.kills + row.kills, deaths: total.deaths + row.deaths, damage: total.damage + row.damage,
}), { kills: 0, deaths: 0, damage: 0 });
const formatScore = value => value.toLocaleString('en-US');

function renderScoreboard(match) {
  $('scoreboard').hidden = !match;
  if (!match) return;
  $('scoreboard').replaceChildren(
    el('div', { className: 'scoreboard-heading' }, [
      el('h3', { textContent: 'Agent performance' }),
      el('span', { textContent: 'Match totals · across all rounds' }),
    ]),
    ...[session.team, otherTeam(session.team)]
      .map(team => scoreTable(match.scoreboard?.[team] ?? [], team)),
    el('p', { className: 'scoreboard-note', textContent: 'Damage is HP dealt. Status shows who survived the latest round.' }),
  );
}

function scoreTable(rows, team) {
  const mine = team === session.team;
  const colors = mine ? OWN_COLORS : ENEMY_COLORS;
  const cells = row => SCORE_COLUMNS.map(([, value]) => el('td', { textContent: formatScore(value(row)) }));
  return el('table', {}, [
    el('caption', { className: mine ? 'own' : 'them', textContent: `${mine ? 'Your squad' : 'Opponent'} · ${TEAMS[team].label}` }),
    el('colgroup', {}, [el('col', { className: 'agent-column' }), ...Array.from({ length: 3 }, () => el('col'))]),
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', textContent: 'Agent / status' }),
      ...SCORE_COLUMNS.map(([head]) => el('th', { scope: 'col', textContent: head })),
    ])]),
    el('tbody', {}, rows.map(row => el('tr', {}, [
      el('th', { scope: 'row' }, [
        el('span', { className: 'score-agent', style: `--agent:${colors[row.slot % colors.length]}` }, [
          el('i', { ariaHidden: 'true' }),
          el('span', {}, [el('b', { textContent: row.name }), el('small', {
            textContent: row.alive == null ? '—' : row.alive ? 'Survived' : 'Eliminated',
          })]),
        ]),
      ]),
      ...cells(row),
    ]))),
    el('tfoot', {}, [el('tr', {}, [el('th', { scope: 'row', textContent: 'Squad total' }), ...cells(scoreTotal(rows))])]),
  ]);
}

function renderResultInsights(match) {
  $('resultInsights').hidden = !match;
  if (!match) return;
  const own = match.scoreboard?.[session.team] ?? [];
  const enemy = match.scoreboard?.[otherTeam(session.team)] ?? [];
  const damage = scoreTotal(own).damage;
  const gap = damage - scoreTotal(enemy).damage;
  const leaders = own.filter(row => row.damage > 0 && row.damage === Math.max(...own.map(r => r.damage)));
  const latest = match.rounds?.at(-1);
  const card = (label, value, detail) => el('div', { className: 'result-insight' }, [
    el('span', { textContent: label }), el('strong', { textContent: value }), el('small', { textContent: detail }),
  ]);
  $('resultInsights').replaceChildren(
    card('Latest round', latest ? `${Math.floor(latest.seconds / 60)}:${String(latest.seconds % 60).padStart(2, '0')}` : '—',
      latest?.reason ?? 'No completed round'),
    card('Squad damage · match', formatScore(damage), gap === 0 ? 'Even with opponent' : `${formatScore(Math.abs(gap))} ${gap > 0 ? 'more' : 'less'} than opponent`),
    card('Damage leader · your squad', leaders.length === 1 ? leaders[0].name : leaders.length ? `${leaders.length} agents tied` : '—',
      leaders.length ? `${formatScore(leaders[0].damage)} damage across the match` : 'No damage dealt yet'),
  );
}

function updateResultActions() {
  const between = Boolean(view?.match && !view.match.over); // the match goes on: this was only a round
  $('swapSides').hidden = between || session.kind !== 'online' || !online?.host || !opponentPresent();
  if (between && (session.kind === 'bots' || opponentPresent())) {
    $('again').hidden = session.kind !== 'bots';
    $('again').textContent = 'Next round';
    setStatus('resultStatus', session.kind === 'bots' ? '' : 'The next round starts in a moment…');
  } else if (session.kind === 'bots') {
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
  const log = $('log');
  const following = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.append(entry);
  while (log.children.length > 30) log.firstChild.remove();
  if (following) log.scrollTop = log.scrollHeight;
  return entry;
}

// Keep the newest entry in view as it fills in, unless you've scrolled back through the log.
function followLog(entry) {
  const log = $('log');
  if (entry !== log.lastChild) return;
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
}

function renderPlan(entry, { plan, latency, tokens, ignored, isOrder, stale, ux, paceMultiplier }, voiceContext, gesture, early = false) {
  const pct = v => `${Math.round(v * 100)}%`;
  if (stale) {
    entry.querySelector('.plan').replaceChildren(el('span', { className: 'skip', textContent: 'Superseded by a newer order' }));
    entry.classList.add('ignored');
    followLog(entry);
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
    followLog(entry);
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
  followLog(entry);
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
        zone: zoneAt(currentMap(), p).name,
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
let frameFailures = 0;

// ---------- stall diagnostics ----------
// A freeze has been reported that no one has yet caught in the act. This watches the loop from
// a timer rather than from inside it, so it still reports when the loop itself has stopped, and
// records enough state to tell the three causes apart: an exception, a lost GPU context, and a
// frame that is merely slow. __diag() in the console prints the same picture on demand.
const diag = { lastFrameAt: 0, longestMs: 0, simMs: 0, drawMs: 0, lastError: null, stalls: 0, reported: false };
function diagSnapshot(gapMs) {
  return {
    gapMs: Math.round(gapMs),
    engine: use3d && !pov3dFailed ? '3d' : '2d',
    pov3dFailed,
    renderer: pov3d?.diagnostics?.() ?? null,
    lastFrameMs: { sim: Math.round(diag.simMs), draw: Math.round(diag.drawMs), longest: Math.round(diag.longestMs) },
    lastError: diag.lastError,
    frameFailures,
    aiming: Boolean(aim),
    pointerLock: document.pointerLockElement?.id ?? null,
    paused: paused(),
    hidden: document.hidden,
    view: view ? { time: +view.time?.toFixed?.(2), result: Boolean(view.result), units: view.units?.length } : null,
    session: session?.kind ?? null,
    is3d,
  };
}
window.__diag = () => diagSnapshot(performance.now() - diag.lastFrameAt);
setInterval(() => {
  if (!diag.lastFrameAt || document.hidden || !session) return;
  const gap = performance.now() - diag.lastFrameAt;
  // rAF runs at least 30/s on any live tab, so a second without one is a stall, not slowness.
  if (gap < 1000) { diag.reported = false; return; }
  if (diag.reported) return;
  diag.reported = true;
  diag.stalls++;
  console.error('[stall] the frame loop has not run for %dms. Copy this:', Math.round(gap), diagSnapshot(gap));
}, 500);
// requestAnimationFrame stops rescheduling the moment a frame throws, and this loop is the only
// thing driving the simulation, the view and the HUD — so an escaping exception doesn't lose one
// frame, it ends the match until the page is reloaded. Keep the loop alive and say what broke.
function frame(now) {
  const began = performance.now();
  try {
    drawFrame(now);
    frameFailures = 0;
  } catch (err) {
    diag.lastError = { message: err?.message ?? String(err), stack: err?.stack?.split('\n').slice(0, 4).join(' | ') };
    if (frameFailures === 0) console.error('Frame failed; the loop is still running.', err);
    // A renderer that fails every frame is not going to recover on its own, and the raycaster
    // draws the same match from the same snapshot.
    if (++frameFailures > 30 && using3d()) dropTo2d('it failed 30 frames in a row');
  }
  const took = performance.now() - began;
  diag.lastFrameAt = performance.now();
  if (took > diag.longestMs) diag.longestMs = took;
  requestAnimationFrame(frame);
}

function drawFrame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  updateHandAim(dt);
  if (aim) {
    if (!matchActive() || !is3d) stopAiming();
    else if (session.kind === 'bots' || now - lastAimSent >= 50) sendAim();
  }
  const simBegan = performance.now();
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
  diag.simMs = performance.now() - simBegan;
  if (session?.kind === 'online') smoothPositions(dt);
  const smoothed = session?.kind === 'online' ? positions : null;
  if (is3d && view && !watched()) {
    if (ownUnits().some(u => u.alive)) cycleAgent(1);
    else setView(false); // the planted round can continue after your entire squad dies
  }
  const drawBegan = performance.now();
  const u = is3d ? watched() : null;
  if (u) {
    const at = unit => smoothed?.get(unit.id) ?? unit;
    const fp = engine();
    fp.setPointer(activePointer());
    lastCamera = camera.update({ ...u, ...at(u) }, dt, aim);
    fp.draw(view, u, lastCamera, at, dt);
    minimap.draw(view, { pointer: activePointer(), positions: smoothed, focusId: u.id, mini: true });
  } else {
    renderer.draw(view, { pointer: activePointer(), positions: smoothed, focusId: watchedId });
  }
  diag.drawMs = performance.now() - drawBegan;
  if (view?.result && !resultShown && session) {
    opponentCommander.reset();
    showResult();
  }
  if (now - lastHud > 100) {
    lastHud = now;
    updateHud();
    syncListening();
  }
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
  if (team) voice.setKeyterms(keytermsFor(team));
  $('scorebar').hidden = !team;
  if (!team) {
    $('opponentCard').hidden = true;
    $('squad').replaceChildren();
    $('scoreClock').textContent = '–';
    $('ownScore').textContent = '0';
    $('enemyScore').textContent = '0';
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

// Two readings of the same match. The log answers "what did I say and what came back"; this
// answers "where is everyone and how sure was Jev", which the log can only tell you by being
// read backwards. Switching is a click, so neither has to carry the other's job.
let jevTab = 'log';
for (const [id, tab] of [['tabLog', 'log'], ['tabAgents', 'agents']]) {
  $(id).onclick = () => {
    jevTab = tab;
    $('tabLog').setAttribute('aria-selected', String(tab === 'log'));
    $('tabAgents').setAttribute('aria-selected', String(tab === 'agents'));
    $('log').hidden = tab !== 'log';
    $('decisions').hidden = tab !== 'agents';
    if (tab === 'agents') renderDecisions();
  };
}

// What Jev weighed, not just what it picked. A 62/24/14 spread and a 96/2/2 spread both read as
// the same order in words; side by side the bars say which one was nearly something else.
function renderDecisions() {
  if (jevTab !== 'agents') return;
  const units = ownUnits();
  const cards = TEAMS[session?.team ?? 'attack'].names.map((name, i) => {
    const u = units.find(unit => unit.name === name);
    const colour = OWN_COLORS[i % OWN_COLORS.length];
    if (!u) return el('div', { className: 'decision dead', style: `--agent:${colour}` }, [el('span', { className: 'name', textContent: name })]);
    const d = u.decision;
    const source = !u.alive ? 'down'
      : d?.obeying ? 'your order'
      : !d ? 'thinking…'
      : d.local ? 'no contact'
      : `Jev ${Math.round(d.latency)} ms`;
    const spread = Object.entries(d?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
    const [, best] = spread[0] ?? [];
    return el('div', { className: `decision${u.alive ? '' : ' dead'}`, style: `--agent:${colour}` }, [
      el('div', { className: 'top' }, [
        el('span', { className: 'name', textContent: u.name }),
        el('span', { className: 'p', textContent: u.alive && best != null ? `${Math.round(best * 100)}%` : '' }),
      ]),
      el('div', { className: 'doing' }, [
        u.orderLabel ?? actionLabel(u, enemyName(u)),
        el('span', { className: 'src', textContent: source }),
      ]),
      // One bar, one segment per option Jev weighed. The width of the second segment is the
      // whole point: it says how nearly this was a different order, which the winning
      // percentage on its own can never show.
      ...(u.alive && spread.length ? [el('div', { className: 'spread' },
        spread.map(([option, p], rank) => el('i', {
          className: rank ? '' : 'pick',
          style: `flex:${Math.max(p, 0.004)}`,
          title: `${option} ${Math.round(p * 100)}%`,
        })))] : []),
    ]);
  });
  $('decisions').replaceChildren(...cards);
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

// The spike, once it's down, is the thing that decides the round: it gets a banner under the
// scoreboard, it turns the clock red, and a defuse shows as a bar filling toward the steal.
let plantAnnounced = null;

function updateSpikeState() {
  const spike = view.spike;
  const planted = spike?.state === 'planted';
  $('spikeState').hidden = !planted;
  $('scoreClock').classList.toggle('spike', planted);
  if (!planted) {
    plantAnnounced = null;
    return;
  }
  if (plantAnnounced !== spike.site) {
    plantAnnounced = spike.site;
    showToast(`Spike planted · ${spike.site}`);
  }
  const defusing = spike.defuse > 0;
  $('spikeState').classList.toggle('defusing', defusing);
  $('spikeWhat').textContent = defusing
    ? `Defusing · ${Math.ceil((1 - spike.defuse) * 6)}s`
    : `Spike · ${spike.site}`;
  $('spikeBar').style.width = `${(defusing ? spike.defuse : 1 - spike.timer / 35) * 100}%`;
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
  $('scoreClock').classList.toggle('prep', Boolean(view.status.prep));
  updateSpikeState();
  updateTitle();
  if (view.match) {
    $('ownScore').textContent = String(view.match.score[session.team]);
    $('enemyScore').textContent = String(view.match.score[otherTeam(session.team)]);
  }
  updateOpponentHud();
  if (!signTimer) renderGestureFeedback();



  const own = view.units.filter(u => u.team === session.team);
  own.forEach((u, i) => {
    const card = $('squad').children[i];
    if (!card) return;
    card.classList.toggle('dead', !u.alive);
    card.classList.toggle('watched', u.id === watchedId);
    // The snapshot carries each agent's colour, and the map, the 3D view and the top bar all
    // read it from there. The card took its colour from its position in the footer instead,
    // which only matched while the squad arrived in slot order.
    card.style.setProperty('--agent', u.color);
    card.querySelector('.name').textContent = u.name;
    card.querySelector('.hp i').style.width = `${(u.hp / u.maxHp) * 100}%`;
    card.querySelector('.doing').textContent = actionLabel(u, enemyName(u));
    card.querySelector('.order').textContent = u.alive
      ? `Order: ${u.orderLabel ?? '–'}${u.grenades ? ' · 💣' : ''}`
      : '';
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
  renderDecisions(); // a no-op unless the squad tab is the one showing

  updateScorebar();
  const watching = watched();
  if (watching) {
    const hp = Math.round(watching.hp);
    $('povHpNum').textContent = hp;
    $('povHp').title = `${hp} / ${watching.maxHp} HP`;
    // Bands rather than a gradient: a colour you can name is read faster than one you compare.
    const left = watching.hp / watching.maxHp;
    $('povHud').dataset.hp = left > 0.6 ? 'ok' : left > 0.3 ? 'low' : 'critical';
    $('povName').textContent = watching.name;
    $('povName').style.color = watching.color;
    $('povZone').textContent = zoneAt(currentMap(), watching).name.toUpperCase();
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

// The mic is either listening or muted, and the button on the camera says which. There is no
// mode to choose any more: holding a key to speak meant the interface had a state you could be
// in without meaning to be, and the only way out was a control you had to go and find.
function syncListening() {
  voice.setListening(matchActive() && !micMuted);
  const state = !voice.enabled ? 'off' : micMuted ? 'muted' : voice.listening ? 'live' : 'on';
  const labels = { off: 'Turn on mic', muted: 'Unmute mic', live: 'Mute mic — listening', on: 'Mute mic' };
  const mic = $('micBtn');
  if (mic.dataset.state !== state) {
    mic.dataset.state = state;
    mic.title = labels[state];
    mic.setAttribute('aria-label', labels[state]);
  }
  $('meter').classList.toggle('live', voice.listening);
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
canvas.addEventListener('click', e => {
  const p = renderer.toWorld(e.clientX, e.clientY);
  if (p.x < 0 || p.y < 0 || p.x > 80 || p.y > 56) return;
  pointer = { ...p, at: performance.now() };
});

// A raised fist aims the first-person view: it lands on the screen like a laser pointer,
// straight ahead from the middle of the frame. Held out near the edge it keeps turning that
// way, so you can still come all the way round without reaching off camera.
const HAND_AIM = { yaw: 1.1, pitch: 0.5, edge: 0.34, turn: 1.8, holdMs: 350 };
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

function updateHandAim(dt) {
  if (aimSource === 'mouse') return; // a locked cursor owns the view until it is released
  const u = watched();
  const live = handAim && performance.now() - handAim.at < HAND_AIM.holdMs;
  if (!live || !is3d || !matchActive() || !u) {
    if (aimSource === 'hand') stopAiming(); // hand down (or out of the view): back to auto
    return;
  }
  const dx = handAim.x - 0.5;
  const dy = handAim.y - 0.5;
  if (aimSource !== 'hand' || aim?.unitId !== u.id) {
    aimSource = 'hand';
    // Pick up from wherever this agent is already looking, without a jump.
    handYaw = wrapAngle((lastCamera?.unitId === u.id ? lastCamera.angle : u.facing) - dx * 2 * HAND_AIM.yaw);
    aim = { unitId: u.id, yaw: u.facing, pitch: 0 };
  }
  const over = Math.max(0, Math.abs(dx) - HAND_AIM.edge) / (0.5 - HAND_AIM.edge);
  handYaw = wrapAngle(handYaw + Math.sign(dx) * over * HAND_AIM.turn * dt);
  aim.yaw = wrapAngle(handYaw + dx * 2 * HAND_AIM.yaw);
  aim.pitch = Math.max(-MANUAL_AIM.maxPitch, Math.min(MANUAL_AIM.maxPitch, -dy * 2 * HAND_AIM.pitch));
}

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
    aimSource = null;
    lastAimEnded = performance.now();
    sendAim();
  }
  aimSource = null;
  if (lockedForAim()) document.exitPointerLock();
}

for (const surface of aimSurfaces) {
  surface.addEventListener('mousedown', async e => {
    if (e.button !== 0 || !matchActive() || !is3d || !watched()) return;
    e.preventDefault();
    if (aimSource === 'mouse') return; // a hand aim can still be taken over by the cursor
    try {
      await surface.requestPointerLock();
    } catch {
      showToast('Click again to aim; your agent is still firing automatically.');
    }
  });
}
document.addEventListener('pointerlockchange', () => {
  if (!lockedForAim()) { stopAiming(); return; }
  const u = watched();
  if (!matchActive() || !is3d || !u) { stopAiming(); return; }
  document.activeElement?.blur();
  aim = { unitId: u.id, yaw: lastCamera?.unitId === u.id ? lastCamera.angle : u.facing, pitch: 0 };
  aimSource = 'mouse';
  sendAim();
});
document.addEventListener('mousemove', e => {
  if (!aim || !lockedForAim()) return;
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
  } else if (e.code === 'KeyG') {
    // Same view, same agent, different renderer — handy for comparing, and a way out if the
    // WebGL one is slow on a given machine. Aiming is dropped first: pointer lock belongs to
    // the canvas being replaced, and V is already push-to-talk.
    stopAiming();
    use3d = !use3d;
    if (is3d) showToast(using3d() ? '3D' : '2D');
    setView(is3d);
  } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    cycleAgent(e.code === 'ArrowRight' ? 1 : -1);
  } else if (/^Digit[1-5]$/.test(e.code)) {
    const u = ownUnits()[Number(e.code.slice(5)) - 1];
    if (u?.alive) watchAgent(u);
  }
});

function setIconState(id, state, label) {
  const button = $(id);
  button.dataset.state = state;
  button.title = label;
  button.setAttribute('aria-label', label);
}

let gestures = null;
let gestureFeedback = { stage: 'none', name: null };

// What the camera is doing right now, in the corner of the preview. Only the three things it
// acts on: the recognizer still confirms the old hand signals, but nothing listens to them, so
// announcing "✋ Hold detected" would promise an order that never arrives.
let lastSign = '';
function renderGestureFeedback({ stage } = gestureFeedback) {
  const text = aimSource === 'hand' ? '✊ Aiming'
    : stage === 'pointing' ? '☝️ Marking a spot'
      : '';
  if (text === lastSign) return;
  lastSign = text;
  $('sign').hidden = !text;
  $('sign').textContent = text;
}

$('previewBtn').onclick = () => {
  const showing = $('cam').hidden;
  $('cam').hidden = !showing;
  setIconState('previewBtn', showing ? 'on' : 'off', showing ? 'Hide preview' : 'Show preview');
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
  setIconState('camBtn', 'off', 'Turn on camera');
  $('camOff').hidden = false;
  $('cam').hidden = false; // the frame stays, showing its placeholder
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
      // Three things the camera does, and nothing else: a fist aims in first person, a finger
      // points at the map, and four fingers change agent. Every order is spoken or typed, so no
      // hand shape can fire one by accident. The recognizer still confirms the old signals and
      // nothing listens; commander.signal() replays one for a scripted demo.
      aiming: () => is3d && matchActive(),
      onAim: p => { handAim = p && { x: p.x, y: p.y, at: performance.now() }; },
      // Pointing works in first person too: the minimap shows the mark, and the 3D view
      // plants a beacon on it. The hand maps to the whole map either way, so the gesture
      // means the same thing in both views.
      onPointer: p => {
        if (!p || !matchActive()) return;
        // Use the middle of the camera frame so you don't have to reach the edges.
        const map = currentMap();
        const spot = cameraToMapPoint(p, map);
        // The defending map is turned around, so pointing “up there” means up the screen.
        pointer = { ...(flippedFor(session?.team) ? flipPoint(map, spot) : spot), at: performance.now() };
      },
      // Four fingers step to the next agent; pinch still switches map/first-person. A thumb out
      // used to do this, and a swipe before that, which went off whenever a hand moved quickly.
      onPointDirection: dir => {
        if (matchActive()) cycleAgent(dir);
      },
      onPinch: () => {
        if (!matchActive()) return;
        showSign(is3d ? '🤏 Map' : '🤏 First-person');
        setView(!is3d);
      },
    });
    setIconState('camBtn', 'on', 'Turn off camera');
    $('previewBtn').hidden = false;
    setIconState('previewBtn', 'on', 'Hide preview');
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
  lastSign = '';
  clearTimeout(signTimer);
  signTimer = setTimeout(() => { signTimer = null; renderGestureFeedback(gestureFeedback); }, 1200);
}

const signChip = (emoji, word, title) => el('span', { title }, [el('b', { textContent: emoji }), word]);
$('signs').replaceChildren(
  signChip('☝️', 'mark', 'Point your index finger straight up to mark a spot on the map, then say what to do there'),
  signChip('✊', 'aim', 'In first person, raise a fist: the crosshair follows it. Lower your hand to go back to automatic fire'),
  signChip('4️⃣', 'agent', 'Hold four fingers up, thumb tucked in. Keep holding to keep stepping through the squad'),
  signChip('🤏', 'view', 'Pinch your thumb and index finger to switch between the map and first-person'),
);

// Mic and camera need a secure page (HTTPS or localhost); typed orders and map clicks always work.
if (!window.isSecureContext) {
  const why = 'needs HTTPS or localhost. Type orders instead.';
  setStatus('micStatus', `Voice ${why}`, 'error');
  setStatus('camStatus', `Camera ${why}`, 'error');
  $('micBtn').disabled = true;
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
  get aim() { return aim && { ...aim, source: aimSource }; },
  // Feed a hand position (0-1 across the camera frame) to try first-person aim without a camera.
  handAim: p => { handAim = p && { x: p.x, y: p.y, at: performance.now() }; },
  setView,
  cycleAgent,
  get utterances() { return [...utterances]; },
  setSpeculative: on => { speculateEnabled = on; },
  point: (x, y) => { pointer = { x, y, at: performance.now() }; },
  voice,
};
