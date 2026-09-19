// Jev Commander (Spike Rush): voice, hand signals, and typed orders → Jev → four agents.
// Vs Bots runs the whole match in this tab. Multiplayer connects to a room on the server,
// which runs the match and streams this player their team's view.
import { createBrains } from './brain.js';
import { SIGNALS, createGestures } from './gestures.js';
import { createRenderer } from './render.js';
import { TEAMS, createGame, stepGame, teamView } from './sim.js';
import { createVoice } from './voice.js';

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

let session = null; // { kind: 'bots' | 'online', team }
let game = null; // bot games only: the local simulation
let brains = null; // bot games only: the attackers' Jev brains
let online = null; // multiplayer connection: { ws, code, team, host, players, pending, seq, jev }
let view = null; // what's on screen: a teamView, local or streamed from the server
let pointer = null; // { x, y, at } marked by clicking the map or pointing at the camera
let resultShown = false;
let is3d = false; // placeholder: the 3D view isn't built yet
const positions = new Map(); // smoothed unit positions for multiplayer

const activePointer = () => (pointer && performance.now() - pointer.at < POINTER_MS ? pointer : null);

// ---------- screens ----------

function showScreen(name) {
  $('overlay').hidden = !name;
  for (const id of ['screenMenu', 'screenOnline', 'screenLobby', 'screenResult']) $(id).hidden = id !== name;
}

function goToMenu() {
  leaveOnline();
  session = null;
  game = null;
  brains = null;
  view = null;
  history.replaceState(null, '', location.pathname);
  updateTeamUi();
  showScreen('screenMenu');
}

$('playBots').onclick = startBotGame;
$('playOnline').onclick = () => {
  setStatus('onlineStatus', '');
  showScreen('screenOnline');
};
$('toggle3d').onclick = () => {
  is3d = !is3d;
  $('toggle3d').setAttribute('aria-pressed', String(is3d));
  $('toggle3d').textContent = `3D: ${is3d ? 'On' : 'Off'}`;
};
$('onlineBack').onclick = goToMenu;
$('lobbyLeave').onclick = goToMenu;
$('resultMenu').onclick = goToMenu;
$('menuBtn').onclick = goToMenu;
$('createRoom').onclick = () => connectOnline(null);
$('joinForm').onsubmit = e => {
  e.preventDefault();
  const code = $('joinCode').value.trim().toUpperCase();
  if (code) connectOnline(code);
};
$('again').onclick = () => {
  if (session?.kind === 'bots') startBotGame();
  else if (online?.host && opponentPresent()) online.ws.send(JSON.stringify({ type: 'start' }));
  else if (online) showScreen('screenLobby');
};
const opponentPresent = () => Boolean(online?.players?.attack && online?.players?.defend);
$('startMatch').onclick = () => online?.ws.send(JSON.stringify({ type: 'start' }));

// ---------- vs bots ----------

function startBotGame() {
  leaveOnline();
  session = { kind: 'bots', team: 'attack' };
  game = createGame({ defenders: 'bots' });
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
  ensureMic();
  resultShown = false;
  positions.clear();
  $('log').replaceChildren();
  $('feed').replaceChildren();
  $('caption').textContent = '';
  updateTeamUi();
  buildSquadCards();
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

async function issueCommand({ source, text, gesture }) {
  if (!text?.trim()) return;
  if (!session || !view || view.result) {
    setStatus('micStatus', 'Start a match first.', 'error');
    return;
  }
  const entry = addLogEntry(source, text, gesture);
  const p = activePointer();
  const request = { text, gesture, pointer: p && { x: p.x, y: p.y } };
  try {
    const result = session.kind === 'bots'
      ? await brains.interpretCommand(game, 'attack', request)
      : await sendCommand(request);
    renderPlan(entry, result);
  } catch (error) {
    entry.querySelector('.plan').replaceChildren();
    entry.querySelector('.meta').replaceChildren(el('span', { className: 'err', textContent: `Jev failed: ${error.message}` }));
  }
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

function addLogEntry(source, text, gesture) {
  const icon = { voice: '🎙', text: '⌨️', hand: gesture?.emoji ?? '✋' }[source];
  const entry = el('div', { className: 'entry' }, [
    el('div', { className: 'said' }, [el('span', { className: 'src', textContent: icon }), text]),
    el('div', { className: 'plan', textContent: 'Jev is reading the order…' }),
    el('div', { className: 'meta' }),
  ]);
  const log = $('log');
  log.prepend(entry);
  while (log.children.length > 30) log.lastChild.remove();
  return entry;
}

function renderPlan(entry, { plan, latency, tokens, ignored, isOrder }) {
  const pct = v => `${Math.round(v * 100)}%`;
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
  entry.querySelector('.meta').textContent = `Jev ${Math.round(latency)} ms · ${tokens ?? '?'} tokens`;
}

function handleSignal(name) {
  if (!session) return;
  const { text, gesture } = signalOrder(name, session.team, Boolean(activePointer()));
  showSign(`${gesture.emoji} ${gesture.label}`);
  issueCommand({ source: 'hand', text, gesture });
}

// ---------- frame loop ----------

let last = performance.now();
let accumulator = 0;
let lastHud = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (session?.kind === 'bots' && game) {
    if (!game.result) {
      accumulator += dt;
      while (accumulator >= STEP) {
        stepGame(game, STEP);
        accumulator -= STEP;
      }
      brains.update(game, 'attack');
    }
    view = teamView(game, 'attack');
  }
  if (session?.kind === 'online') smoothPositions(dt);
  renderer.draw(view, { pointer: activePointer(), positions: session?.kind === 'online' ? positions : null });
  if (view?.result && !resultShown && session) showResult();
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

function updateTeamUi() {
  const team = session?.team;
  $('teamBadge').hidden = !team;
  $('teamBadge').className = `badge ${team ?? ''}`;
  $('teamBadge').textContent = team ? `${TEAMS[team].label}${session.kind === 'online' ? ` · ${online?.code ?? ''}` : ' · vs bots'}` : '';
  $('textInput').placeholder = team === 'defend'
    ? 'Or type an order, e.g. “Echo, Foxtrot hold A. Golf rotate B”'
    : 'Or type an order, e.g. “Alpha, Bravo push B. Charlie hold mid”';
  if (team) voice.setKeyterms(keytermsFor(team));
  if (!team) {
    $('squad').replaceChildren();
    $('clock').textContent = '–';
    $('roundLabel').textContent = '';
    $('jevStats').textContent = '';
  }
}

function buildSquadCards() {
  $('squad').replaceChildren(...TEAMS[session.team].names.map(() => el('div', { className: 'agent' }, [
    el('div', { className: 'top' }, [el('span', { className: 'name' }), el('span', { className: 'brain' })]),
    el('div', { className: 'hp' }, [el('i')]),
    el('div', { className: 'order' }),
    el('div', { className: 'probs' }),
  ])));
}

function updateHud() {
  if (!session || !view) return;
  const seconds = Math.max(0, Math.ceil(view.status.clock));
  $('clock').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('roundLabel').textContent = view.status.label;

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
    card.querySelector('.name').textContent = u.name;
    card.querySelector('.hp i').style.width = `${(u.hp / u.maxHp) * 100}%`;
    card.querySelector('.order').textContent = u.alive ? `Order: ${u.orderLabel}` : 'Down';
    card.querySelector('.brain').textContent = !u.alive ? '' : !u.decision ? 'thinking…'
      : u.decision.local ? 'no contact: following order' : `Jev ${Math.round(u.decision.latency)} ms`;
    const probs = u.alive ? Object.entries(u.decision?.probabilities ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
    card.querySelector('.probs').replaceChildren(...probs.map(([action, p], rank) =>
      el('div', { className: `prob${rank === 0 ? ' top' : ''}` }, [
        el('span', { textContent: action }),
        el('span', { className: 'bar' }, [el('i', { style: `width:${p * 100}%` })]),
        el('span', { textContent: `${Math.round(p * 100)}%` }),
      ])));
  });

  $('feed').replaceChildren(...view.feed.map(f => el('div', { className: f.team === session.team ? 'own' : 'other', textContent: f.text })));
}

// ---------- inputs ----------

const voice = createVoice({
  onInterim: text => { $('caption').textContent = text; },
  onFinal: text => {
    $('caption').textContent = text;
    issueCommand({ source: 'voice', text });
  },
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
  const label = !voice.enabled ? '🎙 Mic off'
    : micMuted ? '🔇 Muted: click to unmute'
    : inMatch ? '🎙 Listening: just talk'
    : '🎙 Mic on: listens during matches';
  if ($('listenLabel').textContent !== label) $('listenLabel').textContent = label;
  $('listen').classList.toggle('live', voice.listening);
  $('micBtn').textContent = !voice.enabled ? 'Turn on mic' : micMuted ? 'Unmute' : 'Mute';
}

async function toggleMic() {
  if (!voice.enabled) {
    micMuted = false;
    await ensureMic();
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

let gestures = null;
$('camBtn').onclick = async () => {
  if (gestures) {
    gestures.stop();
    gestures = null;
    $('camBtn').textContent = 'Enable camera';
    $('camOff').hidden = false;
    $('sign').hidden = true;
    setStatus('camStatus', 'Camera off');
    return;
  }
  try {
    $('camOff').hidden = true;
    gestures = await createGestures({
      video: $('video'),
      overlay: $('hand'),
      onStatus: (text, kind) => setStatus('camStatus', text, kind),
      onPointer: (p, name) => {
        if (!signTimer) {
          $('sign').hidden = name === 'None';
          $('sign').textContent = name === 'Pointing_Up' ? '☝️ Aiming' : SIGNALS[name] ? `${SIGNALS[name].emoji} ${SIGNALS[name].label}…` : name;
        }
        if (!p) return;
        // Use the middle of the camera frame so you don't have to reach the edges.
        const nx = Math.min(1, Math.max(0, (p.x - 0.15) / 0.7));
        const ny = Math.min(1, Math.max(0, (p.y - 0.15) / 0.7));
        pointer = { x: nx * 80, y: ny * 56, at: performance.now() };
      },
      onSignal: handleSignal,
    });
    $('camBtn').textContent = 'Disable camera';
  } catch (error) {
    $('camOff').hidden = false;
    setStatus('camStatus', `Camera unavailable: ${error.message}`, 'error');
  }
};

let signTimer = null;
function showSign(text) {
  $('sign').hidden = false;
  $('sign').textContent = text;
  clearTimeout(signTimer);
  signTimer = setTimeout(() => { signTimer = null; }, 1200);
}

$('signs').replaceChildren(
  el('span', { textContent: '☝️ aim' }),
  ...Object.entries(SIGNALS).map(([name, s]) => el('span', { textContent: `${s.emoji} ${name === 'ILoveYou' ? 'special' : s.label.toLowerCase()}`, title: s.meaning })),
);

// Mic and camera need a secure page (HTTPS or localhost); typed orders and map clicks always work.
if (!window.isSecureContext) {
  const why = 'needs HTTPS or localhost. Type orders and click the map instead.';
  setStatus('micStatus', `Voice ${why}`, 'error');
  setStatus('camStatus', `Camera ${why}`, 'error');
  $('micBtn').disabled = true;
  $('listen').disabled = true;
  $('camBtn').disabled = true;
}

window.addEventListener('resize', () => renderer.resize());

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
requestAnimationFrame(frame);

// Handy for debugging and scripted demos in the console.
window.commander = {
  get session() { return session; },
  get view() { return view; },
  get online() { return online && { code: online.code, team: online.team, host: online.host, players: online.players }; },
  get game() { return game; },
  issueCommand,
  signal: handleSignal,
  point: (x, y) => { pointer = { x, y, at: performance.now() }; },
  voice,
};
