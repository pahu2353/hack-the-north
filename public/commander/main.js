// Jev Commander: voice, hand signals, and typed orders → Jev → a squad of four agents.
import { createBrains, spikeCarrierName } from './brain.js';
import { SIGNALS, createGestures } from './gestures.js';
import { createCamera, createPovRenderer } from './pov.js';
import { createRenderer } from './render.js';
import { SQUADS, actionLabel, aliveSquad, createGame, orderLabel, roundStatus, squad, stepGame } from './sim.js';
import { zoneAt } from './world.js';
import { createVoice } from './voice.js';

const STEP = 1 / 60;
const $ = id => document.getElementById(id);

const MODES = {
  tactical: {
    title: 'Spike Rush',
    intro: 'You command Alpha, Bravo, Charlie and Delta against four defender bots. Left alone they rush the nearest site and shoot whoever they see, so orders are how you change the plan. Alpha carries the spike: get it planted on A or B (stand on site, 3s) and defend it, or wipe the defenders. Try “Everyone push B”, “Alpha and Bravo hold mid, Charlie and Delta flank A”, or point at the map and say “go there”.',
    keyterms: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'A Site', 'B Site', 'A Main', 'B Main', 'Mid', 'A Link', 'B Link', 'spike', 'plant', 'flank', 'regroup'],
  },
  titan: {
    title: 'Titan Siege',
    intro: 'Commander Erwin: Levi, Mikasa, Hange and Armin must hold the gate for 150s against waves of small, big and abnormal titans. Blades only kill from behind: aim for the nape (the red dot). Try “Levi and Mikasa flank the big one”, “everyone protect the gate”, or “Hange, attack Main Street”.',
    keyterms: ['Levi', 'Mikasa', 'Hange', 'Armin', 'Erwin', 'titan', 'nape', 'gate', 'Plaza', 'Main Street', 'West District', 'East District', 'Wall Breach', 'flank', 'regroup'],
  },
};

// What each hand signal says, per scenario. The words go to Jev like any other order.
// In first-person the order is for the watched agent only, so "Everyone" becomes their name.
function signalOrder(name, game) {
  const order = squadSignalOrder(name, game);
  const u = watched();
  if (view === 'pov' && u) order.text = order.text.replace(/^Everyone/, u.name);
  return order;
}

function squadSignalOrder(name, game) {
  const pointed = game.pointer && performance.now() - game.pointer.at < 8000;
  const tactical = game.mode === 'tactical';
  const orders = {
    Thumb_Up: pointed ? 'Everyone push there!' : 'Everyone push forward!',
    Open_Palm: 'Everyone hold your positions!',
    Closed_Fist: 'Everyone regroup!',
    Thumb_Down: tactical ? 'Everyone fall back to spawn!' : 'Everyone fall back to the gate!',
    Victory: tactical
      ? 'Alpha and Bravo push A Site. Charlie and Delta push B Site.'
      : 'Levi and Mikasa flank through the West District. Hange and Armin flank through the East District.',
    ILoveYou: tactical
      ? `${spikeCarrierName(game) ?? 'Alpha'}, plant the spike${pointed ? ' there' : ' on B Site'}. Everyone else push with them.`
      : 'Everyone attack! Aim for the nape!',
  };
  const label = name === 'ILoveYou' ? (tactical ? 'Plant' : 'All-out attack') : SIGNALS[name].label;
  return { text: orders[name], gesture: { ...SIGNALS[name], label } };
}

const canvas = $('map');
const renderer = createRenderer(canvas);
const povCanvas = $('pov');
const pov = createPovRenderer(povCanvas);
const minimap = createRenderer($('minimap'));
const camera = createCamera();
const brains = createBrains();
let mode = 'tactical';
let game = createGame(mode);
let running = false;

// ---------- view: the top-down map (default) or one agent's first-person view ----------

let view = 'map';
let watchedId = null;
const watched = () => game.units.find(u => u.id === watchedId && u.alive) ?? null;

function setView(next) {
  view = next;
  $('arena').dataset.view = view;
  $('viewBtn').replaceChildren(view === 'map' ? 'First-person ' : 'Map ', el('kbd', { textContent: 'Tab' }));
  $('hint').textContent = view === 'map'
    ? 'Click the map (or point at the camera) to mark a spot, then say “push there”. Tab or pinch: first-person.'
    : 'Watching this agent. Every order here is for them alone. ←/→ or swipe: switch agent · Tab or pinch: map.';
  if (view === 'map') renderer.resize(game.map);
  else {
    if (!watched()) watchedId = aliveSquad(game)[0]?.id ?? null;
    minimap.resize(game.map);
  }
  updateScorebar();
}

// Step through the living agents in top-bar order, wrapping around.
function cycleAgent(dir) {
  const alive = aliveSquad(game);
  if (!alive.length) return;
  const order = squad(game);
  const from = order.findIndex(u => u.id === watchedId);
  for (let step = 1; step <= order.length; step++) {
    const next = order[(((from + dir * step) % order.length) + order.length) % order.length];
    if (next.alive) {
      watchAgent(next);
      return;
    }
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

// ---------- orders ----------

async function issueCommand({ source, text, gesture }) {
  if (!text?.trim()) return;
  // First-person is one agent's view, so every order given there is for them alone.
  const only = view === 'pov' ? watched()?.name : undefined;
  const entry = addLogEntry(source, only ? `→ ${only}: ${text}` : text, gesture);
  try {
    const { plan, latency, tokens } = await brains.interpretCommand(game, { text, gesture, only });
    renderPlan(entry, plan, latency, tokens);
  } catch (error) {
    entry.querySelector('.plan').replaceChildren();
    entry.querySelector('.meta').replaceChildren(el('span', { className: 'err', textContent: `Jev failed: ${error.message}` }));
  }
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

function renderPlan(entry, plan, latency, tokens) {
  const rows = plan.flatMap(p => {
    const pct = v => `${Math.round(v * 100)}%`;
    if (!p.applied) {
      return [
        el('span', { className: 'skip', textContent: p.name }),
        el('span', { className: 'skip', textContent: 'not addressed' }),
        el('span', { className: 'p', textContent: pct(p.addressed), title: 'P(addressed)' }),
      ];
    }
    const detail = `${p.order} → ${p.target}${p.priority && p.priority !== 'any' ? ` (${p.priority} first)` : ''}`;
    return [
      el('span', { textContent: p.name }),
      el('span', { textContent: detail, title: `addressed ${pct(p.addressed)} · order ${pct(p.orderP)} · target ${pct(p.targetP)}` }),
      el('span', { className: 'p', textContent: pct(p.orderP * p.targetP), title: 'P(order) × P(target)' }),
    ];
  });
  entry.querySelector('.plan').replaceChildren(...rows);
  entry.querySelector('.meta').textContent = `Jev ${Math.round(latency)} ms · ${tokens ?? '?'} tokens`;
}

const SQUAD_ONLY_SIGNALS = { Victory: '✌️ Split', ILoveYou: '🤟 Special' };

function handleSignal(name) {
  if (view === 'pov' && SQUAD_ONLY_SIGNALS[name]) {
    showSign(`${SQUAD_ONLY_SIGNALS[name]}: map view only`);
    return;
  }
  const { text, gesture } = signalOrder(name, game);
  showSign(`${gesture.emoji} ${gesture.label}`);
  issueCommand({ source: 'hand', text, gesture });
}

// ---------- game lifecycle ----------

function newGame(nextMode, { start = false } = {}) {
  mode = nextMode;
  game = createGame(mode);
  renderer.resize(game.map);
  $('log').replaceChildren();
  $('feed').replaceChildren();
  buildSquadCards();
  buildScorebar();
  watchedId = aliveSquad(game)[0]?.id ?? null;
  setView(view);
  running = start;
  showOverlay(!start, MODES[mode].title, MODES[mode].intro, 'Start');
  voice.setKeyterms([...MODES[mode].keyterms]);
  $('textInput').placeholder = mode === 'tactical'
    ? 'Or type an order, e.g. “Alpha, Bravo push B. Charlie hold mid”'
    : 'Or type an order, e.g. “Levi and Mikasa flank the big titans”';
}

function showOverlay(visible, title, text, button, outcome) {
  $('overlay').hidden = !visible;
  $('overlayTitle').textContent = title;
  $('overlayTitle').className = outcome ?? '';
  $('overlayText').textContent = text;
  $('start').textContent = button;
}

let last = performance.now();
let accumulator = 0;
let lastHud = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running && !game.result) {
    accumulator += dt;
    while (accumulator >= STEP) {
      stepGame(game, STEP);
      accumulator -= STEP;
    }
    brains.update(game);
  }
  if (running && game.result) {
    running = false;
    const won = game.result.winner === 'squad';
    showOverlay(true, won ? 'Victory' : 'Defeat', game.result.reason, 'Play again', won ? 'win' : 'lose');
  }
  if (view === 'pov' && !watched()) cycleAgent(1); // the watched agent died
  const u = watched();
  if (view === 'pov' && u) {
    pov.draw(game, u, camera.update(u, dt));
    minimap.draw(game, { focusId: u.id, mini: true });
  } else {
    renderer.draw(game, { focusId: watchedId });
  }
  if (now - lastHud > 100) {
    lastHud = now;
    updateHud();
  }
  requestAnimationFrame(frame);
}

// ---------- HUD ----------

// Valorant-style top bar: squad portraits (left, in switching order), clock, enemies (right).
// The dead drop off the bar.
function buildScorebar() {
  const portrait = (u, onclick) => {
    const node = el('button', {
      type: 'button', className: 'portrait', title: u.name, style: `--agent:${u.color}`, onclick,
    }, [
      el('span', { className: 'face', textContent: u.team === 'squad' ? u.name[0] : u.name.slice(1) }),
      el('span', { className: 'bar' }, [el('i')]),
      ...(u.team === 'squad' ? [el('span', { className: 'who', textContent: u.name })] : []),
    ]);
    u.portrait = node;
    return node;
  };
  $('squadBar').replaceChildren(...squad(game).map(u => portrait(u, () => watchAgent(u))));
  $('enemyBar').replaceChildren(...game.units.filter(u => u.team === 'enemy').map(u => portrait(u)));
}

function updateScorebar() {
  for (const u of game.units) {
    if (!u.portrait) continue;
    u.portrait.hidden = !u.alive;
    u.portrait.classList.toggle('active', u.id === watchedId);
    u.portrait.querySelector('.bar i').style.width = `${(u.hp / u.maxHp) * 100}%`;
  }
  // Titans spawn mid-game, so add their portraits as they appear.
  const missing = game.units.filter(u => u.team === 'enemy' && !u.portrait && u.alive);
  for (const u of missing) {
    const node = el('button', { type: 'button', className: 'portrait', title: u.name, style: `--agent:${u.color}` }, [
      el('span', { className: 'face', textContent: u.name.slice(1) }),
      el('span', { className: 'bar' }, [el('i')]),
    ]);
    u.portrait = node;
    $('enemyBar').append(node);
  }
}

function buildSquadCards() {
  $('squad').replaceChildren(...squad(game).map(u => {
    const card = el('div', { className: 'agent', style: `--agent:${u.color}`, onclick: () => watchAgent(u) }, [
      el('div', { className: 'top' }, [
        el('span', { className: 'name', textContent: u.name }),
        el('span', { className: 'brain' }),
      ]),
      el('div', { className: 'hp' }, [el('i')]),
      el('div', { className: 'doing' }),
      el('div', { className: 'order' }),
      el('div', { className: 'probs' }),
    ]);
    u.card = card;
    return card;
  }));
}

function updateHud() {
  const status = roundStatus(game);
  const seconds = Math.max(0, Math.ceil(status.clock));
  $('scoreClock').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  updateScorebar();
  const u = watched();
  if (u) {
    $('povHp').textContent = Math.round(u.hp);
    $('povName').textContent = u.name;
    $('povName').style.color = u.color;
    $('povAction').textContent = `${actionLabel(game, u)} · order: ${orderLabel(u)}`;
    $('povZone').textContent = zoneAt(game.map, u).name.toUpperCase();
  }
  $('roundLabel').textContent = status.label;

  const s = brains.summary();
  $('jevStats').replaceChildren(
    'Jev ', el('b', { textContent: `${s.perMinute}/min` }),
    ' · p50 ', el('b', { textContent: s.p50 ? `${s.p50} ms` : '–' }),
    ` · ${s.ok} ok · ${s.failed} failed`,
  );
  $('jevStats').title = s.lastError;

  for (const u of squad(game)) {
    const card = u.card;
    card.classList.toggle('dead', !u.alive);
    card.classList.toggle('watched', u.id === watchedId);
    card.querySelector('.hp i').style.width = `${u.hp}%`;
    card.querySelector('.doing').textContent = actionLabel(game, u);
    card.querySelector('.order').textContent = u.alive ? `Order: ${orderLabel(u)}` : '';
    card.querySelector('.brain').textContent = !u.alive ? ''
      : !u.decision ? (u.brain ? '…' : '')
      : u.decision.local ? 'no contact' : `Jev ${Math.round(u.decision.latency)} ms`;
    // Just the chosen action's confidence: the full spread was more noise than signal.
    const [action, p] = Object.entries(u.decision?.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
    card.querySelector('.probs').replaceChildren(...(action && u.alive ? [
      el('div', { className: 'prob top' }, [
        el('span', { textContent: action }),
        el('span', { className: 'bar' }, [el('i', { style: `width:${p * 100}%` })]),
        el('span', { textContent: `${Math.round(p * 100)}%` }),
      ]),
    ] : []));
  }

  const recent = game.feed.filter(f => game.time - f.t < 8).slice(-5);
  $('feed').replaceChildren(...recent.map(f => el('div', { className: f.team, textContent: f.text })));
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

$('micBtn').onclick = async () => {
  if (voice.enabled) {
    voice.disable();
    $('micBtn').textContent = 'Enable mic';
    setStatus('micStatus', 'Mic off');
    return;
  }
  try {
    await voice.enable([...MODES[mode].keyterms]);
    $('micBtn').textContent = 'Disable mic';
  } catch (error) {
    setStatus('micStatus', `Mic unavailable: ${error.message}`, 'error');
  }
};

function startTalking() {
  if (!voice.enabled) {
    setStatus('micStatus', 'Enable the mic first (or type the order).', 'error');
    return;
  }
  $('ptt').classList.add('live');
  voice.startTalking();
}
function stopTalking() {
  $('ptt').classList.remove('live');
  voice.stopTalking();
}
const typing = () => document.activeElement?.tagName === 'INPUT';
document.addEventListener('keydown', e => {
  if (typing()) return;
  if (e.code === 'KeyV' && !e.repeat) {
    e.preventDefault();
    startTalking();
  } else if (e.code === 'Tab') {
    e.preventDefault();
    setView(view === 'map' ? 'pov' : 'map');
  } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    cycleAgent(e.code === 'ArrowRight' ? 1 : -1);
  } else if (/^Digit[1-4]$/.test(e.code)) {
    const u = squad(game)[Number(e.code.slice(5)) - 1];
    if (u?.alive) watchAgent(u);
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'KeyV' && !typing()) stopTalking();
});
$('ptt').addEventListener('pointerdown', startTalking);
$('ptt').addEventListener('pointerup', stopTalking);
$('ptt').addEventListener('pointerleave', () => $('ptt').classList.contains('live') && stopTalking());

$('textForm').onsubmit = e => {
  e.preventDefault();
  const text = $('textInput').value;
  $('textInput').value = '';
  $('textInput').blur();
  issueCommand({ source: 'text', text });
};

canvas.addEventListener('click', e => markSpot(renderer.toWorld(e.clientX, e.clientY)));
// No aiming in first-person: it's a view for watching one agent, not for marking spots.
povCanvas.addEventListener('click', () => showToast('Aim from the map view'));

function markSpot(p) {
  if (!p || p.x < 0 || p.y < 0 || p.x > game.map.width || p.y > game.map.height) return;
  game.pointer = { ...p, at: performance.now() };
}

let gestures = null;
$('previewBtn').onclick = () => {
  const showing = $('cam').hidden;
  $('cam').hidden = !showing;
  $('previewBtn').textContent = showing ? 'Hide preview' : 'Show preview';
};
$('camBtn').onclick = async () => {
  if (gestures) {
    gestures.stop();
    gestures = null;
    $('camBtn').textContent = 'Enable camera';
    $('camOff').hidden = false;
    $('cam').hidden = true;
    $('previewBtn').hidden = true;
    $('lastSign').textContent = '';
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
          const label = name === 'Pointing_Up' ? '☝️ Aiming' : SIGNALS[name] ? `${SIGNALS[name].emoji} ${SIGNALS[name].label}…` : '';
          $('sign').hidden = name === 'None';
          $('sign').textContent = label;
          $('lastSign').textContent = label;
        }
        if (!p) return;
        // Use the middle of the camera frame so you don't have to reach the edges.
        const nx = Math.min(1, Math.max(0, (p.x - 0.15) / 0.7));
        const ny = Math.min(1, Math.max(0, (p.y - 0.15) / 0.7));
        if (view === 'pov') return; // aiming is map-view only
        game.pointer = { x: nx * game.map.width, y: ny * game.map.height, at: performance.now() };
      },
      onSignal: handleSignal,
      onSwipe: dir => {
        // Swiping drags the bar like a carousel: hand to the right brings the agent on the left.
        showSign(dir > 0 ? '👉 Previous agent' : '👈 Next agent');
        cycleAgent(-dir);
      },
      onPinch: () => {
        showSign(view === 'map' ? '🤏 First-person' : '🤏 Map');
        setView(view === 'map' ? 'pov' : 'map');
      },
    });
    $('camBtn').textContent = 'Disable camera';
    $('previewBtn').hidden = false;
    $('previewBtn').textContent = 'Hide preview';
    $('cam').hidden = false;
  } catch (error) {
    $('camOff').hidden = false;
    setStatus('camStatus', `Camera unavailable: ${error.message}`, 'error');
  }
};

let signTimer = null;
function showSign(text) {
  $('sign').hidden = false;
  $('sign').textContent = text;
  $('lastSign').textContent = text;
  clearTimeout(signTimer);
  signTimer = setTimeout(() => { signTimer = null; }, 1200);
}

$('signs').replaceChildren(
  el('span', { textContent: '☝️ aim', title: 'Point to mark a spot on the map' }),
  el('span', { textContent: '👋 agent', title: 'Swipe left or right to switch agents' }),
  el('span', { textContent: '🤏 view', title: 'Pinch to switch between the map and first-person' }),
  ...Object.entries(SIGNALS).map(([name, s]) => el('span', {
    textContent: `${s.emoji} ${name === 'ILoveYou' ? 'special' : s.label.toLowerCase()}`, title: s.meaning,
  })),
);

$('start').onclick = () => {
  if (game.result) newGame(mode, { start: true });
  else {
    running = true;
    $('overlay').hidden = true;
  }
};
$('restart').onclick = () => newGame(mode, { start: true });
$('mode').onchange = e => newGame(e.target.value);
$('viewBtn').onclick = () => setView(view === 'map' ? 'pov' : 'map');
window.addEventListener('resize', () => setView(view));

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

newGame(mode);
requestAnimationFrame(frame);

// Handy for debugging and scripted demos in the console.
window.commander = {
  get game() { return game; },
  get running() { return running; },
  brains,
  voice,
  issueCommand,
  signal: handleSignal,
  point: (x, y) => { game.pointer = { x, y, at: performance.now() }; },
  get view() { return view; },
  setView,
  cycleAgent,
  squadNames: () => SQUADS[mode],
};
