// Game simulation: squad agents (steered by Jev), defender bots, titans, and round rules.
import { opponentDestination } from './opponent.js';
import {
  MAPS, angleDiff, angleTo, buildGrid, clamp, dist, findPath, hasLineOfSight,
  nearestOpenPoint, walkableLine, zoneAt, zoneByName,
} from './world.js';

export const SQUADS = {
  tactical: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
  titan: ['Levi', 'Mikasa', 'Hange', 'Armin'],
};

const RIFLE = { range: 45, damage: 35, interval: 0.22, accuracy: 0.6 };
const BLADE = { reach: 1.5, damage: 45, napeDamage: 150, interval: 0.7 };
const SQUAD_SIGHT = 45;
const PLANT_SECONDS = 3;
const DEFUSE_SECONDS = 6;
const TITAN_TYPES = {
  // Grabs are telegraphed (windup) and leave the titan frozen (recover): dodge, then cut the nape.
  small: { r: 1.3, hp: 120, speed: 3.4, damage: 30, reach: 1.2, turn: 1.3, aggro: 16, windup: 0.45, recover: 1.1 },
  big: { r: 2.8, hp: 420, speed: 2.0, damage: 70, reach: 1.6, turn: 0.7, aggro: 20, windup: 0.75, recover: 1.6 },
  abnormal: { r: 1.8, hp: 200, speed: 5.0, damage: 45, reach: 1.4, turn: 2.2, aggro: 26, windup: 0.35, recover: 0.8 },
};
const ROTATE_SPOTS = [{ x: 16, y: 10 }, { x: 64, y: 10 }];
const WAVES = 5;
const WAVE_INTERVAL = 25;

export function createGame(mode, { opponent = 'scripted' } = {}) {
  const map = MAPS[mode];
  const game = {
    mode,
    opponent: mode === 'tactical' ? opponent : 'scripted',
    map,
    grids: new Map(),
    time: 0,
    units: [],
    effects: [],
    feed: [],
    result: null,
    nextId: 1,
    squadIntel: new Map(),
    enemyIntel: new Map(),
    pointer: null,
  };
  const squadKind = mode === 'tactical' ? 'agent' : 'scout';
  SQUADS[mode].forEach((name, i) => {
    game.units.push(makeUnit(game, {
      team: 'squad',
      kind: squadKind,
      name,
      ...map.spawns.squad[i],
      r: 0.6,
      hp: 100,
      maxHp: 100,
      speed: mode === 'tactical' ? 5 : 7.5,
      reaction: 0.25,
      action: 'hold',
      focusId: null,
      decision: null,
    }));
  });

  if (mode === 'tactical') {
    map.spawns.bots.forEach((post, i) => {
      game.units.push(makeUnit(game, {
        team: 'enemy', kind: 'bot', name: `E${i + 1}`, x: post.x, y: post.y, post, r: 0.6, hp: 100, maxHp: 100,
        speed: 4.5, reaction: 0.28 + Math.random() * 0.12, facing: Math.PI / 2,
      }));
    });
    game.spike = { state: 'carried', carrierId: squad(game)[0].id, x: 0, y: 0, progress: 0, timer: 35, defuse: 0, site: null };
    game.roundTime = 100;
  } else {
    game.gate = { ...map.gate, hp: 1000, maxHp: 1000 };
    game.wave = 0;
    game.nextWaveAt = 3;
    game.surviveTime = 150;
    game.kills = 0;
    game.titanCount = 0;
  }

  const startZone = mode === 'tactical' ? 'Attacker Spawn' : 'Plaza';
  for (const u of squad(game)) setOrder(game, u, { type: 'hold', zone: startZone, point: { x: u.x, y: u.y } });
  return game;
}

function makeUnit(game, props) {
  return {
    id: game.nextId++,
    alive: true,
    facing: -Math.PI / 2,
    cooldown: 0,
    path: [],
    pathGoal: null,
    repathAt: 0,
    moving: false,
    seen: new Map(),
    visible: [],
    targetId: null,
    lastShotAt: -Infinity,
    stillSince: 0,
    ...props,
  };
}

export const squad = game => game.units.filter(u => u.team === 'squad');
export const aliveSquad = game => game.units.filter(u => u.team === 'squad' && u.alive);
export const unitById = (game, id) => game.units.find(u => u.id === id);

function grid(game, clearance) {
  const key = Math.round(clearance * 10) / 10;
  if (!game.grids.has(key)) game.grids.set(key, buildGrid(game.map, key));
  return game.grids.get(key);
}
const gridFor = (game, u) => grid(game, u.kind === 'titan' ? Math.min(u.r * 0.8, 2) : 0.7);

// ---------- orders ----------

export function setOrder(game, u, order) {
  const o = { priority: 'any', ...order, via: null, viaReached: false };
  const route = game.map.routes[o.zone];
  let viaZone = null;
  if (o.type === 'flank' && route?.flank) {
    const others = aliveSquad(game).filter(m => m !== u);
    const centroid = others.length ? average(others) : u;
    viaZone = route.flank
      .map(name => zoneByName(game.map, name))
      .reduce((a, b) => (dist(b.center, centroid) > dist(a.center, centroid) ? b : a));
  } else if (['push', 'plant', 'attack'].includes(o.type) && route?.push) {
    viaZone = zoneByName(game.map, route.push);
  }
  // Only detour through the route if it's actually on the way (not behind us).
  if (viaZone && dist(viaZone.center, o.point) < dist(u, o.point) && zoneAt(game.map, u) !== viaZone) o.via = viaZone.center;
  u.order = o;
  u.path = [];
  u.pathGoal = null;
  u.coverPoint = null;
}

export function orderLabel(u) {
  const { type, zone } = u.order;
  return type === 'regroup' ? 'regroup' : `${type} → ${zone}`;
}

export function orderDestination(game, u) {
  const o = u.order;
  if (o.type === 'regroup') return average(aliveSquad(game));
  if (o.type === 'protect' && game.gate) return zoneByName(game.map, 'Gate').center;
  if (o.via && !o.viaReached) {
    if (dist(u, o.via) < 3) o.viaReached = true;
    else return o.via;
  }
  return o.point;
}

function average(units) {
  const n = units.length || 1;
  return { x: units.reduce((s, u) => s + u.x, 0) / n, y: units.reduce((s, u) => s + u.y, 0) / n };
}

// ---------- main step ----------

export function stepGame(game, dt) {
  if (game.result) return;
  game.time += dt;
  updateVision(game);
  for (const u of game.units) {
    if (!u.alive) continue;
    u.cooldown = Math.max(0, u.cooldown - dt);
    if (u.team === 'squad') controlSquad(game, u, dt);
    else if (u.kind === 'bot') controlBot(game, u, dt);
    else controlTitan(game, u, dt);
  }
  resolveCollisions(game);
  if (game.mode === 'tactical') updateSpike(game, dt);
  else updateWaves(game);
  game.effects = game.effects.filter(e => (e.ttl -= dt) > 0);
  checkResult(game);
}

function updateVision(game) {
  const living = game.units.filter(u => u.alive);
  for (const u of living) {
    const range = u.kind === 'titan' ? u.aggro : SQUAD_SIGHT;
    const visible = [];
    for (const other of living) {
      if (other.team === u.team) continue;
      if (dist(u, other) <= range + other.r && hasLineOfSight(game.map, u, other)) {
        visible.push(other);
        if (!u.seen.has(other.id)) u.seen.set(other.id, game.time);
      } else {
        u.seen.delete(other.id);
      }
    }
    u.visible = visible.sort((a, b) => dist(u, a) - dist(u, b));
    const intel = u.team === 'squad' ? game.squadIntel : game.enemyIntel;
    for (const other of visible) intel.set(other.id, { x: other.x, y: other.y, t: game.time });
  }
}

// ---------- squad (Jev picks u.action; this executes it every frame) ----------

function controlSquad(game, u, dt) {
  const focus = u.visible.find(e => e.id === u.focusId) ?? u.visible[0] ?? null;
  const objective = orderDestination(game, u);
  let dest = null;
  switch (u.action) {
    case 'advance':
      dest = objective;
      break;
    case 'cover':
      if (!u.coverPoint || (focus && hasLineOfSight(game.map, focus, u.coverPoint))) u.coverPoint = findCover(game, u);
      dest = u.coverPoint;
      break;
    case 'support': {
      const mate = aliveSquad(game).filter(m => m !== u && m.visible.length).sort((a, b) => dist(u, a) - dist(u, b))[0];
      dest = mate ?? objective;
      break;
    }
    case 'strike':
      dest = focus ? strikePoint(u, focus) : objective;
      break;
    case 'flank':
      dest = focus ? flankPoint(u, focus) : objective;
      break;
    case 'evade':
      dest = focus ? evadePoint(game, u, focus) : objective;
      break;
    case 'protect':
      dest = zoneByName(game.map, 'Gate')?.center ?? objective;
      break;
    default: // hold, fight
      dest = null;
  }
  // Reflexes between Jev decisions: with nothing to fight, carry out the commander's order,
  // and whoever is closest picks up a dropped spike.
  const idle = !focus && ['hold', 'fight', 'strike', 'flank', 'evade'].includes(u.action);
  if (idle && dist(u, objective) > 3) dest = objective;
  const spike = game.spike;
  if (!focus && spike?.state === 'dropped') {
    const nearest = aliveSquad(game).reduce((a, b) => (dist(b, spike) < dist(a, spike) ? b : a));
    if (nearest === u) dest = { x: spike.x, y: spike.y };
  }
  // Scouts dodge a telegraphed grab on reflex, unless Jev has them committed to a strike.
  if (game.mode === 'titan' && u.action !== 'strike') {
    const threat = u.visible.find(t => t.status === 'windup' && angleDiff(t.facing, angleTo(t, u)) < 1.3 && dist(t, u) - t.r < t.reach + 1.5);
    if (threat) dest = evadePoint(game, u, threat);
  }
  if (dest && dist(u, dest) < 0.8) dest = null;

  moveToward(game, u, dest, dt);
  if (game.mode === 'tactical') {
    if (focus) shoot(game, u, focus);
  } else {
    slash(game, u, focus);
  }
}

function findCover(game, u) {
  const threats = u.visible.length ? u.visible : [...game.squadIntel.values()].filter(i => game.time - i.t < 3);
  const g = gridFor(game, u);
  let best = null;
  for (const radius of [3, 5, 7, 9]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const p = { x: u.x + Math.cos(a) * radius, y: u.y + Math.sin(a) * radius };
      if (p.x < 1 || p.y < 1 || p.x > game.map.width - 1 || p.y > game.map.height - 1) continue;
      if (!walkableLine(g, u, p)) continue;
      if (threats.every(t => !hasLineOfSight(game.map, t, p))) {
        if (!best || dist(u, p) < dist(u, best)) best = p;
      }
    }
    if (best) return best;
  }
  const threat = threats[0];
  if (!threat) return { x: u.x, y: u.y };
  const away = angleTo(threat, u);
  return nearestOpenPoint(g, { x: u.x + Math.cos(away) * 6, y: u.y + Math.sin(away) * 6 });
}

// Circle the titan at a given radius, stepping toward its back (the nape side).
function orbitPoint(u, t, radius) {
  const current = angleTo(t, u);
  const back = t.facing + Math.PI;
  const diff = ((back - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const a = current + clamp(diff, -0.8, 0.8);
  return { x: t.x + Math.cos(a) * radius, y: t.y + Math.sin(a) * radius };
}

const isBehind = (u, t) => angleDiff(t.facing, angleTo(t, u)) > 1.9;

// Strike: orbit tight until behind the titan, then dive for the nape.
function strikePoint(u, t) {
  if (!isBehind(u, t)) return orbitPoint(u, t, t.r + t.reach + 1.2);
  const back = t.facing + Math.PI;
  return { x: t.x + Math.cos(back) * (t.r + 0.6), y: t.y + Math.sin(back) * (t.r + 0.6) };
}

// Flank: orbit wide, staying out of reach, to set up a strike (or draw its attention).
const flankPoint = (u, t) => orbitPoint(u, t, t.r + t.reach + 2.5);

function evadePoint(game, u, t) {
  const away = angleTo(t, u);
  return nearestOpenPoint(gridFor(game, u), { x: u.x + Math.cos(away) * 10, y: u.y + Math.sin(away) * 10 });
}

function shoot(game, u, target) {
  if (u.cooldown > 0 || !target.alive) return;
  if (game.time - (u.seen.get(target.id) ?? game.time) < u.reaction) return;
  const d = dist(u, target);
  if (d > RIFLE.range) return;
  u.cooldown = RIFLE.interval;
  u.facing = angleTo(u, target);
  u.targetId = target.id;
  u.lastShotAt = game.time;
  // Standing still is what wins gunfights: moving costs 70% of your accuracy.
  let p = RIFLE.accuracy * clamp(1 - d / 55, 0.15, 1);
  if (u.moving) p *= 0.3;
  else if (game.time - u.stillSince > 1) p *= 1.25; // holding an angle
  if (target.moving) p *= 0.8;
  const hit = Math.random() < p;
  const miss = hit ? 0 : (Math.random() - 0.5) * 3;
  game.effects.push({
    kind: 'tracer', team: u.team, ttl: 0.08,
    x1: u.x, y1: u.y, x2: target.x + miss, y2: target.y - miss,
  });
  if (hit) damage(game, target, RIFLE.damage, u);
}

function slash(game, u, focus) {
  if (u.cooldown > 0) return;
  const candidates = focus ? [focus, ...u.visible.filter(t => t !== focus)] : u.visible;
  for (const t of candidates) {
    if (dist(u, t) - t.r > BLADE.reach) continue;
    const fromBehind = isBehind(u, t);
    if (u.action !== 'strike' && !fromBehind) continue; // only commit from the front when told to strike
    u.cooldown = BLADE.interval;
    u.facing = angleTo(u, t);
    u.targetId = t.id;
    u.lastShotAt = game.time;
    game.effects.push({ kind: 'slash', x: t.x, y: t.y, r: t.r + 0.6, nape: fromBehind, ttl: 0.25 });
    damage(game, t, fromBehind ? BLADE.napeDamage : BLADE.damage, u, fromBehind);
    return;
  }
}

function damage(game, target, amount, source, nape = false) {
  if (!target.alive) return;
  target.hp -= amount;
  target.lastHitAt = game.time;
  if (target.hp > 0) return;
  target.hp = 0;
  target.alive = false;
  target.moving = false;
  game.effects.push({ kind: 'death', x: target.x, y: target.y, r: target.r, team: target.team, ttl: 8 });
  const how = target.kind === 'titan' ? (nape ? 'cut the nape of' : 'brought down') : 'eliminated';
  pushFeed(game, `${source.name} ${how} ${target.kind === 'titan' ? `${target.class} titan ${target.name}` : target.name}`, source.team);
  if (target.kind === 'titan') game.kills++;
  if (game.spike?.state === 'carried' && game.spike.carrierId === target.id) {
    Object.assign(game.spike, { state: 'dropped', carrierId: null, x: target.x, y: target.y, progress: 0 });
    pushFeed(game, `Spike dropped by ${target.name}`, 'squad');
  }
}

export function pushFeed(game, text, team) {
  game.feed.push({ text, team, t: game.time });
  if (game.feed.length > 8) game.feed.shift();
}

// ---------- movement ----------

function moveToward(game, u, dest, dt) {
  const wasMoving = u.moving;
  step(game, u, dest, dt);
  if (wasMoving && !u.moving) u.stillSince = game.time;
}

function step(game, u, dest, dt) {
  if (!dest) {
    u.moving = false;
    return;
  }
  const g = gridFor(game, u);
  if (!u.pathGoal || dist(u.pathGoal, dest) > 1.5 || game.time > u.repathAt) {
    u.path = walkableLine(g, u, dest) ? [dest] : findPath(g, u, dest);
    u.pathGoal = { x: dest.x, y: dest.y };
    u.repathAt = game.time + (u.kind === 'titan' ? 0.8 : 1.2);
  }
  while (u.path.length && dist(u, u.path[0]) < 0.4) u.path.shift();
  const waypoint = u.path[0];
  if (!waypoint) {
    u.moving = false;
    return;
  }
  const heading = angleTo(u, waypoint);
  let speed = u.speed;
  if (u.kind === 'titan') {
    // Titans turn slowly and only walk the way they face, which is what makes flanking work.
    u.facing = turnToward(u.facing, heading, u.turn * dt);
    speed *= Math.max(0.25, Math.cos(angleDiff(u.facing, heading)));
  } else if (game.time - u.lastShotAt > 0.4) {
    u.facing = heading;
  }
  const step = Math.min(speed * dt, dist(u, waypoint));
  u.x += Math.cos(heading) * step;
  u.y += Math.sin(heading) * step;
  u.moving = step > 0.001;
}

function turnToward(current, target, maxStep) {
  let diff = ((target - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  diff = clamp(diff, -maxStep, maxStep);
  return current + diff;
}

function resolveCollisions(game) {
  const living = game.units.filter(u => u.alive);
  for (const u of living) {
    for (const w of game.map.walls) pushOutOfRect(u, w);
    if (game.gate) pushOutOfRect(u, game.gate);
  }
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const a = living[i];
      const b = living[j];
      const d = dist(a, b);
      const overlap = a.r + b.r - d;
      if (overlap <= 0 || d === 0) continue;
      const ma = a.r * a.r;
      const mb = b.r * b.r;
      const nx = (b.x - a.x) / d;
      const ny = (b.y - a.y) / d;
      a.x -= nx * overlap * (mb / (ma + mb));
      a.y -= ny * overlap * (mb / (ma + mb));
      b.x += nx * overlap * (ma / (ma + mb));
      b.y += ny * overlap * (ma / (ma + mb));
    }
  }
}

function pushOutOfRect(u, w) {
  const cx = clamp(u.x, w.x, w.x + w.w);
  const cy = clamp(u.y, w.y, w.y + w.h);
  const dx = u.x - cx;
  const dy = u.y - cy;
  const d = Math.hypot(dx, dy);
  if (d >= u.r) return;
  if (d > 0) {
    u.x = cx + (dx / d) * u.r;
    u.y = cy + (dy / d) * u.r;
    return;
  }
  // Centre inside the rectangle: leave by the shortest side.
  const exits = [
    [u.x - w.x, -1, 0], [w.x + w.w - u.x, 1, 0], [u.y - w.y, 0, -1], [w.y + w.h - u.y, 0, 1],
  ].sort((a, b) => a[0] - b[0]);
  const [depth, ex, ey] = exits[0];
  u.x += ex * (depth + u.r);
  u.y += ey * (depth + u.r);
}

// ---------- defender bots (scripted) ----------

function controlBot(game, u, dt) {
  const focus = u.visible[0];
  const planned = opponentDestination(game, u);
  if (focus) {
    if (planned && u.botOrder.action === 'retreat') {
      moveToward(game, u, dist(u, planned) < 1.2 ? null : planned, dt);
    } else if (u.hp < 50 && u.visible.length >= 2) {
      // Outnumbered and hurt: fall back to cover instead of trading badly.
      if (!u.coverPoint || hasLineOfSight(game.map, focus, u.coverPoint)) u.coverPoint = findCover(game, u);
      moveToward(game, u, u.coverPoint, dt);
    } else {
      moveToward(game, u, null, dt);
    }
    shoot(game, u, focus);
    return;
  }
  u.coverPoint = null;
  let dest = planned ?? u.post;
  const spike = game.spike;
  if (!planned && spike.state === 'planted') {
    dest = { x: spike.x, y: spike.y };
  } else if (!planned && u.post.rotate) {
    // Rotators fall back onto whichever site the latest callout threatens.
    const callout = [...game.enemyIntel.values()].filter(i => game.time - i.t < 8).sort((a, b) => b.t - a.t)[0];
    if (callout) dest = ROTATE_SPOTS.reduce((a, b) => (dist(b, callout) < dist(a, callout) ? b : a));
  }
  if (dist(u, dest) < 1.2) dest = null;
  moveToward(game, u, dest, dt);
}

// ---------- spike (tactical) ----------

function updateSpike(game, dt) {
  const spike = game.spike;
  if (spike.state === 'carried') {
    const carrier = unitById(game, spike.carrierId);
    spike.x = carrier.x;
    spike.y = carrier.y;
    const zone = zoneAt(game.map, carrier);
    const onSite = game.map.sites.includes(zone.name);
    if (onSite && !carrier.moving && carrier.visible.length === 0) {
      spike.progress += dt;
      if (spike.progress >= PLANT_SECONDS) {
        Object.assign(spike, { state: 'planted', carrierId: null, site: zone.name, progress: 0 });
        pushFeed(game, `${carrier.name} planted the spike on ${zone.name}`, 'squad');
      }
    } else {
      spike.progress = 0;
    }
  } else if (spike.state === 'dropped') {
    const picker = aliveSquad(game).find(u => dist(u, spike) < 1.4);
    if (picker) {
      Object.assign(spike, { state: 'carried', carrierId: picker.id });
      pushFeed(game, `${picker.name} picked up the spike`, 'squad');
    }
  } else if (spike.state === 'planted') {
    spike.timer -= dt;
    const defuser = game.units.find(u => u.alive && u.kind === 'bot' && dist(u, spike) < 1.5 && !u.visible.length);
    spike.defuse = defuser ? spike.defuse + dt : Math.max(0, spike.defuse - dt * 0.5);
    if (spike.defuse >= DEFUSE_SECONDS) {
      spike.state = 'defused';
      pushFeed(game, `${defuser.name} defused the spike`, 'enemy');
    }
  }
}

// ---------- titans (scripted) ----------

function spawnWave(game, wave) {
  const counts = { small: 1 + wave, big: wave >= 2 ? Math.floor(wave / 2) : 0, abnormal: wave >= 3 ? 1 : 0 };
  for (const [type, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      const spec = TITAN_TYPES[type];
      game.titanCount++;
      game.units.push(makeUnit(game, {
        team: 'enemy', kind: 'titan', class: type, name: `T${game.titanCount}`,
        x: 8 + Math.random() * 64, y: 3 + Math.random() * 4,
        facing: Math.PI / 2, ...spec, maxHp: spec.hp, wobble: Math.random() * 10, status: 'walking', statusUntil: 0,
      }));
    }
  }
  pushFeed(game, `Wave ${wave}: ${counts.small} small, ${counts.big} big, ${counts.abnormal} abnormal`, 'enemy');
}

function controlTitan(game, t, dt) {
  const gate = game.gate;
  if (t.status === 'windup') {
    if (game.time < t.statusUntil) return;
    resolveGrab(game, t);
    t.status = 'recovering';
    t.statusUntil = game.time + t.recover;
    return;
  }
  if (t.status === 'recovering') {
    if (game.time < t.statusUntil) return; // frozen: the opening scouts wait for
    t.status = 'walking';
  }

  const prey = t.visible[0];
  let dest;
  if (prey) {
    dest = prey;
  } else {
    dest = { x: clamp(t.x, gate.x + 2, gate.x + gate.w - 2), y: gate.y - t.r - 0.3 };
    if (t.class === 'abnormal' && t.y < gate.y - 12) dest = { x: dest.x + Math.sin(game.time * 1.3 + t.wobble) * 14, y: dest.y };
  }
  moveToward(game, t, dest, dt);

  const preyInReach = prey && dist(t, prey) - prey.r <= t.r + t.reach + 0.8 && angleDiff(t.facing, angleTo(t, prey)) < 1.0;
  const atGate = !prey && t.y + t.r >= gate.y - 1.2 && t.x > gate.x - 1 && t.x < gate.x + gate.w + 1;
  if (preyInReach || atGate) {
    t.status = 'windup';
    t.statusUntil = game.time + t.windup;
    t.moving = false;
    t.targetId = prey?.id ?? null;
  }
}

// The grab lands on whoever is still in front of the titan and within reach when the windup ends.
function resolveGrab(game, t) {
  t.lastShotAt = game.time;
  const victim = aliveSquad(game)
    .filter(u => dist(t, u) - u.r <= t.r + t.reach && angleDiff(t.facing, angleTo(t, u)) < 1.2)
    .sort((a, b) => dist(t, a) - dist(t, b))[0];
  const reachX = t.x + Math.cos(t.facing) * (t.r + t.reach * 0.6);
  const reachY = t.y + Math.sin(t.facing) * (t.r + t.reach * 0.6);
  game.effects.push({ kind: 'grab', x: reachX, y: reachY, r: t.reach + 0.4, ttl: 0.3, hit: Boolean(victim) });
  if (victim) {
    damage(game, victim, t.damage, { name: `${t.class} titan ${t.name}`, team: 'enemy' });
  } else if (t.y + t.r >= game.gate.y - 1.5 && t.x > game.gate.x - 1 && t.x < game.gate.x + game.gate.w + 1) {
    game.gate.hp = Math.max(0, game.gate.hp - t.damage);
  }
}

function updateWaves(game) {
  if (game.wave < WAVES && game.time >= game.nextWaveAt) {
    game.wave++;
    spawnWave(game, game.wave);
    game.nextWaveAt += WAVE_INTERVAL;
  }
}

// ---------- results ----------

function checkResult(game) {
  const squadAlive = aliveSquad(game).length;
  const enemiesAlive = game.units.filter(u => u.team === 'enemy' && u.alive).length;
  let result = null;
  if (!squadAlive) result = { winner: 'enemy', reason: 'Your squad was wiped out' };
  else if (game.mode === 'tactical') {
    const spike = game.spike;
    if (!enemiesAlive) result = { winner: 'squad', reason: 'Enemy team eliminated' };
    else if (spike.state === 'defused') result = { winner: 'enemy', reason: 'The spike was defused' };
    else if (spike.state === 'planted' && spike.timer <= 0) result = { winner: 'squad', reason: `Spike detonated on ${spike.site}` };
    else if (spike.state !== 'planted' && game.time >= game.roundTime) result = { winner: 'enemy', reason: 'Time ran out before the plant' };
  } else if (game.gate.hp <= 0) result = { winner: 'enemy', reason: 'The titans broke through the gate' };
  else if (game.time >= game.surviveTime) result = { winner: 'squad', reason: 'Held the gate until reinforcements arrived' };
  else if (game.wave >= WAVES && !enemiesAlive) result = { winner: 'squad', reason: 'Every titan was cut down' };
  if (result) game.result = { ...result, time: game.time };
}

export function roundStatus(game) {
  if (game.mode === 'tactical') {
    const s = game.spike;
    if (s.state === 'planted') return { clock: s.timer, label: `Spike planted on ${s.site}` };
    const carrier = unitById(game, s.carrierId);
    return { clock: game.roundTime - game.time, label: s.state === 'dropped' ? 'Spike dropped' : `Spike: ${carrier?.name}` };
  }
  return {
    clock: game.surviveTime - game.time,
    label: `Wave ${game.wave}/${WAVES} · Gate ${Math.round(game.gate.hp)} · Kills ${game.kills}`,
  };
}
