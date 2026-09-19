// Spike Rush simulation: attackers vs defenders, four each. A team is either commanded by a
// player (agents steered by Jev) or, for defenders in bot mode, scripted bots. Runs in the
// browser for bot games and on the server for multiplayer.
import { defenderCombat, opponentDestination, updateOpponentTactics } from './opponent.js';
import {
  MAPS, angleTo, buildGrid, clamp, dist, findPath, hasLineOfSight,
  nearestOpenPoint, walkableLine, zoneAt, zoneByName,
} from './world.js';

export const TEAMS = {
  attack: { label: 'Attackers', names: ['Alpha', 'Bravo', 'Charlie', 'Delta'] },
  defend: { label: 'Defenders', names: ['Echo', 'Foxtrot', 'Golf', 'Hotel'] },
};
export const otherTeam = team => (team === 'attack' ? 'defend' : 'attack');

// One colour per agent, in squad order, so an agent looks the same on the top bar, the map,
// the first-person view and their card. Always from the viewer's side: yours blue, theirs red.
// Four shades of one hue per side. They stay light enough to read as text on the dark panel
// and to take dark lettering inside a filled chip.
export const OWN_COLORS = ['#d3e8ff', '#96c6ff', '#59a0f7', '#3a7fdd'];
export const ENEMY_COLORS = ['#ffd2cc', '#ffa79c', '#f4705f', '#dc4a37'];

const RIFLE = { range: 45, damage: 35, interval: 0.22, accuracy: 0.6 };
const SIGHT = 45;
const PLANT_SECONDS = 3;
const DEFUSE_SECONDS = 6;
export const ROUND_SECONDS = 100;
const SPIKE_SECONDS = 35;
const ROTATE_SPOTS = [{ x: 16, y: 10 }, { x: 64, y: 10 }];
// Grenades are the answer to a squad that just walks around as one clump: one throw reaches
// everyone standing together. The fuse is long enough that Jev can decide to scatter in time.
export const GRENADE = {
  carried: 1, range: 26, radius: 5, centreDamage: 72, edgeDamage: 20,
  speed: 17, fuse: 1.2, cooldown: 1.5, clusterGap: 5,
};
// Agents sent to the same zone each take their own spot around its centre; if they all aimed
// for the same point they'd shove each other forever (and a carrier that never stops can't plant).
const SLOTS = [{ x: 0, y: 0 }, { x: 2.2, y: 0.6 }, { x: -2.2, y: 0.6 }, { x: 0, y: 2.4 }];

// defenders selects bot mode or multiplayer; playerTeam chooses the human's side in bot mode.
export function createGame({ defenders = 'bots', opponent = 'scripted', playerTeam = 'attack' } = {}) {
  const map = MAPS.tactical;
  const game = {
    map,
    defenders,
    botTeam: defenders === 'bots' ? otherTeam(playerTeam) : null,
    opponent: defenders === 'bots' ? opponent : 'scripted',
    grids: new Map(),
    time: 0,
    units: [],
    effects: [],
    feed: [],
    result: null,
    nextId: 1,
    intel: { attack: new Map(), defend: new Map() },
    grenades: [],
    knownDown: { attack: new Set(), defend: new Set() },
  };
  for (const team of ['attack', 'defend']) map.spawns[team].forEach((post, i) => {
    if (team === game.botTeam) {
      game.units.push(makeUnit(game, {
        team, kind: 'bot', name: `E${i + 1}`, slot: i, x: post.x, y: post.y, post, r: 0.6, hp: 100, maxHp: 100,
        speed: 4.5, reaction: 0.28 + Math.random() * 0.12, facing: team === 'attack' ? -Math.PI / 2 : Math.PI / 2,
      }));
    } else {
      game.units.push(makeAgent(game, team, TEAMS[team].names[i], post, i));
    }
  });
  game.spike = { state: 'carried', carrierId: teamUnits(game, 'attack')[0].id, x: 0, y: 0, progress: 0, timer: SPIKE_SECONDS, defuse: 0, site: null };
  for (const u of game.units) {
    if (u.kind === 'agent') setOrder(game, u, defaultOrder(game, u));
  }
  return game;
}

function makeAgent(game, team, name, at, slot) {
  return makeUnit(game, {
    team, kind: 'agent', name, slot, x: at.x, y: at.y, r: 0.6, hp: 100, maxHp: 100, speed: 5, reaction: 0.25,
    facing: team === 'attack' ? -Math.PI / 2 : Math.PI / 2,
    action: team === 'attack' ? 'advance' : 'hold', focusId: null, decision: null,
  });
}

function makeUnit(game, props) {
  return {
    id: game.nextId++,
    alive: true,
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
    grenades: GRENADE.carried,
    throwReadyAt: 0,
    ...props,
  };
}

// What an agent does before the commander says anything: attackers rush the nearer site
// (and shoot whoever they meet), defenders hold where they spawned.
export function defaultOrder(game, u) {
  if (u.team !== 'attack') return { type: 'hold', zone: zoneAt(game.map, u).name, point: { x: u.x, y: u.y } };
  const from = average(teamUnits(game, 'attack'));
  const site = game.map.sites
    .map(name => zoneByName(game.map, name))
    .reduce((a, b) => (dist(b.center, from) < dist(a.center, from) ? b : a));
  return { type: 'push', zone: site.name, point: site.center };
}

export const teamUnits = (game, team) => game.units.filter(u => u.team === team);
export const aliveTeam = (game, team) => game.units.filter(u => u.team === team && u.alive);
export const unitById = (game, id) => game.units.find(u => u.id === id);

function gridFor(game) {
  if (!game.grids.has('agent')) game.grids.set('agent', buildGrid(game.map, 0.7));
  return game.grids.get('agent');
}

// ---------- orders ----------

export function setOrder(game, u, order) {
  const o = { ...order, via: null, viaReached: false };
  const zoneCenter = zoneByName(game.map, o.zone)?.center;
  if (zoneCenter && dist(zoneCenter, o.point) < 0.01) {
    const slot = SLOTS[TEAMS[u.team].names.indexOf(u.name)] ?? SLOTS[0];
    o.point = nearestOpenPoint(gridFor(game), { x: o.point.x + slot.x, y: o.point.y + slot.y });
  }
  const route = game.map.routes[o.zone];
  let viaZone = null;
  let maxDetour = 1.5;
  if (o.type === 'flank' && route?.flank) {
    const others = aliveTeam(game, u.team).filter(m => m !== u);
    const centroid = others.length ? average(others) : u;
    viaZone = route.flank
      .map(name => zoneByName(game.map, name))
      .reduce((a, b) => (dist(b.center, centroid) > dist(a.center, centroid) ? b : a));
    maxDetour = 2;
  } else if (['push', 'plant'].includes(o.type) && route?.push) {
    viaZone = zoneByName(game.map, route.push);
  }
  // Only detour through the route when it's roughly on the way (routes are drawn for attackers).
  if (viaZone && zoneAt(game.map, u) !== viaZone) {
    const detour = dist(u, viaZone.center) + dist(viaZone.center, o.point);
    if (detour < dist(u, o.point) * maxDetour) o.via = viaZone.center;
  }
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
  if (o.type === 'regroup') return average(aliveTeam(game, u.team));
  if (o.type === 'defuse' && game.spike.state === 'planted') return { x: game.spike.x, y: game.spike.y };
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
  updateOpponentTactics(game);
  for (const u of game.units) {
    if (!u.alive) continue;
    u.cooldown = Math.max(0, u.cooldown - dt);
    if (u.kind === 'bot') controlBot(game, u, dt);
    else controlAgent(game, u, dt);
  }
  resolveCollisions(game);
  updateGrenades(game);
  updateSpike(game, dt);
  game.effects = game.effects.filter(e => (e.ttl -= dt) > 0);
  checkResult(game);
}

function updateVision(game) {
  const living = game.units.filter(u => u.alive);
  for (const u of living) {
    const visible = [];
    for (const other of living) {
      if (other.team === u.team) continue;
      if (dist(u, other) <= SIGHT && hasLineOfSight(game.map, u, other)) {
        visible.push(other);
        if (!u.seen.has(other.id)) u.seen.set(other.id, game.time);
      } else {
        u.seen.delete(other.id);
      }
    }
    u.visible = visible.sort((a, b) => dist(u, a) - dist(u, b));
    for (const other of visible) game.intel[u.team].set(other.id, { x: other.x, y: other.y, t: game.time });
  }
}

// ---------- agents (Jev picks u.action; this executes it every frame) ----------

function controlAgent(game, u, dt) {
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
      const mate = aliveTeam(game, u.team).filter(m => m !== u && m.visible.length).sort((a, b) => dist(u, a) - dist(u, b))[0];
      dest = mate ?? objective;
      break;
    }
    case 'nade': {
      const target = u.order.type === 'grenade' ? { spot: u.order.point } : grenadeSpot(game, u);
      if (!target) dest = objective;
      else if (throwGrenade(game, u, target.spot)) dest = null;
      else dest = target.spot; // out of range or no line: walk it in
      break;
    }
    case 'scatter': {
      const bomb = incomingGrenade(game, u);
      dest = bomb ? evadePoint(game, u, bomb) : objective;
      break;
    }
    default: // hold, fight
      dest = null;
  }
  // A grenade order is carried out as soon as the thrower is in range, then they hold there.
  if (u.order.type === 'grenade' && u.grenades > 0 && u.action !== 'scatter') {
    if (throwGrenade(game, u, u.order.point)) {
      setOrder(game, u, { type: 'hold', zone: zoneAt(game.map, u).name, point: { x: u.x, y: u.y } });
      dest = null;
    } else if (u.action !== 'fight') {
      dest = u.order.point;
    }
  }
  // Nothing left to throw: fight instead of standing there.
  if (u.action === 'nade' && u.grenades < 1) u.action = focus ? 'fight' : 'advance';
  // Reflexes between Jev decisions: with nothing to fight, carry out the commander's order,
  // and the nearest attacker picks up a dropped spike.
  if (!focus && ['hold', 'fight'].includes(u.action) && dist(u, objective) > 3) dest = objective;
  const spike = game.spike;
  if (!focus && u.team === 'attack' && spike.state === 'dropped') {
    const nearest = aliveTeam(game, 'attack').reduce((a, b) => (dist(b, spike) < dist(a, spike) ? b : a));
    if (nearest === u) dest = { x: spike.x, y: spike.y };
  }
  if (dest && dist(u, dest) < 0.8) dest = null;
  moveToward(game, u, dest, dt);
  if (focus) shoot(game, u, focus);
}

// Somewhere clear of a blast, in the walkable direction away from it.
function evadePoint(game, u, from) {
  const away = angleTo(from, u);
  const g = gridFor(game);
  for (const angle of [0, 0.6, -0.6, 1.2, -1.2, 2]) {
    const p = { x: u.x + Math.cos(away + angle) * (GRENADE.radius + 2.5), y: u.y + Math.sin(away + angle) * (GRENADE.radius + 2.5) };
    if (p.x > 1 && p.y > 1 && p.x < game.map.width - 1 && p.y < game.map.height - 1 && walkableLine(g, u, p)) return p;
  }
  return nearestOpenPoint(g, { x: u.x + Math.cos(away) * 6, y: u.y + Math.sin(away) * 6 });
}

function findCover(game, u) {
  const threats = u.visible.length ? u.visible : [...game.intel[u.team].values()].filter(i => game.time - i.t < 3);
  const g = gridFor(game);
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

function damage(game, target, amount, source) {
  if (!target.alive) return;
  target.hp -= amount;
  target.lastHitAt = game.time;
  if (target.hp > 0) return;
  target.hp = 0;
  target.alive = false;
  target.moving = false;
  game.effects.push({ kind: 'death', x: target.x, y: target.y, r: target.r, team: target.team, ttl: 8 });
  game.knownDown[source.team].add(target.id); // you know the ones you killed
  pushFeed(game, `${source.name} eliminated ${target.name}`, source.team);
  if (game.spike.state === 'carried' && game.spike.carrierId === target.id) {
    Object.assign(game.spike, { state: 'dropped', carrierId: null, x: target.x, y: target.y, progress: 0 });
    pushFeed(game, `Spike dropped by ${target.name}`, 'attack', 'attack');
  }
}

// audience: 'all', or the one team allowed to see the entry (e.g. spike drops are attacker-only).
export function pushFeed(game, text, team, audience = 'all') {
  game.feed.push({ text, team, audience, t: game.time });
  if (game.feed.length > 12) game.feed.shift();
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
  const g = gridFor(game);
  if (!u.pathGoal || dist(u.pathGoal, dest) > 1.5 || game.time > u.repathAt) {
    u.path = walkableLine(g, u, dest) ? [dest] : findPath(g, u, dest);
    u.pathGoal = { x: dest.x, y: dest.y };
    u.repathAt = game.time + 1.2;
  }
  while (u.path.length && dist(u, u.path[0]) < 0.4) u.path.shift();
  const waypoint = u.path[0];
  if (!waypoint) {
    u.moving = false;
    return;
  }
  const heading = angleTo(u, waypoint);
  if (game.time - u.lastShotAt > 0.4) u.facing = heading;
  const distance = Math.min(u.speed * dt, dist(u, waypoint));
  u.x += Math.cos(heading) * distance;
  u.y += Math.sin(heading) * distance;
  u.moving = distance > 0.001;
}

function resolveCollisions(game) {
  const living = game.units.filter(u => u.alive);
  for (const u of living) {
    for (const w of game.map.walls) pushOutOfRect(u, w);
  }
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const a = living[i];
      const b = living[j];
      const d = dist(a, b);
      const overlap = a.r + b.r - d;
      if (overlap <= 0 || d === 0) continue;
      const nx = (b.x - a.x) / d;
      const ny = (b.y - a.y) / d;
      a.x -= (nx * overlap) / 2;
      a.y -= (ny * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.y += (ny * overlap) / 2;
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

// ---------- bots (scripted execution, with optional OpenAI objectives) ----------

function controlBot(game, u, dt) {
  const focus = u.visible.find(v => v.alive);
  // Bots use grenades by rule: punish a group, and don't stand in one.
  const bomb = incomingGrenade(game, u);
  if (bomb) {
    moveToward(game, u, evadePoint(game, u, bomb), dt);
    if (focus) shoot(game, u, focus);
    return;
  }
  // Throwing is instant, so it happens the moment a group is in sight, whether the bot then
  // holds its angle or falls back. A squad that moves as one clump pays for it.
  if (u.grenades > 0) {
    const clump = grenadeSpot(game, u);
    if (clump && clump.caught >= 2) throwGrenade(game, u, clump.spot);
  }
  const planned = opponentDestination(game, u);
  if (planned && ['retreat', 'regroup'].includes(u.botOrder.action)) {
    // Spotting an enemy must not turn a withdrawal into another isolated fight.
    u.botFallback = null;
    moveToward(game, u, dist(u, planned) < 1.2 ? null : planned, dt);
    if (focus) shoot(game, u, focus);
    return;
  }
  if (game.opponent === 'openai') {
    const combat = defenderCombat(game, u);
    const strength = combat.nearbyAllies + 1;
    const overwhelmed = combat.visibleEnemies >= strength * 2
      || (u.hp < 50 && combat.visibleEnemies > strength);
    if (overwhelmed) {
      if (!u.botFallback) {
        u.botFallback = { point: findCover(game, u), recheckAt: game.time + 0.5 };
      } else if (game.time >= u.botFallback.recheckAt) {
        if (u.visible.some(v => v.alive && hasLineOfSight(game.map, v, u.botFallback.point))) {
          u.botFallback.point = findCover(game, u);
        }
        u.botFallback.recheckAt = game.time + 0.5;
      }
      Object.assign(u.botFallback, { until: game.time + 4, enemies: combat.visibleEnemies, allies: strength });
    } else if (u.botFallback && (game.time >= u.botFallback.until || strength >= u.botFallback.enemies)) {
      u.botFallback = null;
    }
    if (u.botFallback) {
      // Keep the escape point after breaking sight, rather than walking straight back
      // into the same crossfire. Resume when support arrives or after a short recovery.
      const safe = u.botFallback.point;
      moveToward(game, u, dist(u, safe) < 0.8 ? null : safe, dt);
      if (focus) shoot(game, u, focus);
      return;
    }
  }
  const group = game.botRetake;
  if (planned && group?.unitIds.includes(u.id)) {
    // Gather under fire, then advance together. The survival reflex above still takes priority.
    moveToward(game, u, dist(u, planned) < 1.2 ? null : planned, dt);
    if (focus) shoot(game, u, focus);
    return;
  }
  if (focus) {
    // Outnumbered and hurt: fall back to cover instead of trading badly.
    if (u.hp < 50 && u.visible.length >= 2) {
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
  if (u.team === 'attack') {
    if (!planned) {
      const site = zoneByName(game.map, spike.site ?? 'B Site');
      const slot = SLOTS[u.slot % SLOTS.length];
      dest = { x: site.center.x + slot.x, y: site.center.y + slot.y };
    }
    if (spike.state === 'dropped') {
      const picker = aliveTeam(game, 'attack').reduce((a, b) => dist(a, spike) <= dist(b, spike) ? a : b);
      if (u === picker) dest = { x: spike.x, y: spike.y };
    }
  } else if (!planned && spike.state === 'planted') {
    dest = { x: spike.x, y: spike.y };
  } else if (!planned && u.post.rotate) {
    // Rotators fall back onto whichever site the latest callout threatens.
    const callout = [...game.intel.defend.values()].filter(i => game.time - i.t < 8).sort((a, b) => b.t - a.t)[0];
    if (callout) dest = ROTATE_SPOTS.reduce((a, b) => (dist(b, callout) < dist(a, callout) ? b : a));
  }
  if (dist(u, dest) < 1.2) dest = null;
  moveToward(game, u, dest, dt);
}

// ---------- grenades ----------

// The point that catches the most enemies: the middle of a group. Like a real player, this
// counts people seen a moment ago as well as right now, so a squad moving as one clump can be
// hit just after it ducks out of sight.
export function grenadeSpot(game, u, memory = 2) {
  const marks = u.visible.filter(e => e.alive).map(e => ({ x: e.x, y: e.y }));
  for (const [id, seen] of game.intel[u.team]) {
    const target = unitById(game, id);
    if (!target?.alive || target.team === u.team) continue;
    if (game.time - seen.t > memory || u.visible.some(v => v.id === id)) continue;
    marks.push({ x: seen.x, y: seen.y });
  }
  if (marks.length < 2) return null;
  let best = null;
  for (const centre of marks) {
    const caught = marks.filter(m => dist(m, centre) <= GRENADE.clusterGap);
    const spot = average(caught);
    if (!hasLineOfSight(game.map, u, spot) || dist(u, spot) > GRENADE.range) continue;
    if (!best || caught.length > best.caught) best = { spot, caught: caught.length };
  }
  return best;
}

export function throwGrenade(game, u, point) {
  if (u.grenades < 1 || game.time < u.throwReadyAt) return false;
  if (dist(u, point) > GRENADE.range || !hasLineOfSight(game.map, u, point)) return false;
  u.grenades--;
  u.throwReadyAt = game.time + GRENADE.cooldown;
  u.facing = angleTo(u, point);
  game.grenades.push({
    id: game.nextId++, team: u.team, throwerId: u.id,
    x: u.x, y: u.y, fromX: u.x, fromY: u.y, tx: point.x, ty: point.y,
    thrownAt: game.time, landAt: game.time + Math.max(0.35, dist(u, point) / GRENADE.speed), explodeAt: 0,
  });
  pushFeed(game, `${u.name} threw a grenade`, u.team, u.team);
  return true;
}

// A grenade already on the ground near a unit, which it should run away from.
export function incomingGrenade(game, u) {
  return game.grenades
    .filter(g => g.explodeAt && dist(g, u) <= GRENADE.radius + 2)
    .sort((a, b) => a.explodeAt - b.explodeAt)[0] ?? null;
}

function updateGrenades(game) {
  for (const g of game.grenades) {
    if (!g.explodeAt) {
      const flight = (game.time - g.thrownAt) / Math.max(0.001, g.landAt - g.thrownAt);
      if (flight >= 1) {
        g.x = g.tx;
        g.y = g.ty;
        g.explodeAt = game.time + GRENADE.fuse;
      } else {
        g.x = g.fromX + (g.tx - g.fromX) * flight;
        g.y = g.fromY + (g.ty - g.fromY) * flight;
      }
    } else if (game.time >= g.explodeAt) {
      explode(game, g);
      g.done = true;
    }
  }
  game.grenades = game.grenades.filter(g => !g.done);
}

// Damage falls off toward the edge of the blast, and walls block it.
function explode(game, g) {
  game.effects.push({ kind: 'blast', x: g.x, y: g.y, r: GRENADE.radius, team: g.team, ttl: 0.45 });
  const thrower = unitById(game, g.throwerId) ?? { name: 'A grenade', team: g.team };
  for (const target of game.units) {
    if (!target.alive || target.team === g.team) continue;
    const d = dist(g, target);
    if (d > GRENADE.radius || !hasLineOfSight(game.map, g, target)) continue;
    const share = 1 - d / GRENADE.radius;
    damage(game, target, Math.round(GRENADE.edgeDamage + (GRENADE.centreDamage - GRENADE.edgeDamage) * share), thrower);
  }
}

// ---------- the spike ----------

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
        pushFeed(game, `${carrier.name} planted the spike on ${zone.name}`, 'attack');
      }
    } else {
      spike.progress = 0;
    }
  } else if (spike.state === 'dropped') {
    const picker = aliveTeam(game, 'attack').find(u => dist(u, spike) < 1.4);
    if (picker) {
      Object.assign(spike, { state: 'carried', carrierId: picker.id });
      pushFeed(game, `${picker.name} picked up the spike`, 'attack', 'attack');
    }
  } else if (spike.state === 'planted') {
    spike.timer -= dt;
    // A defender standing on the spike with no attacker in sight defuses it.
    const defuser = aliveTeam(game, 'defend').find(u => dist(u, spike) < 1.5 && !u.visible.length && !u.moving);
    spike.defuse = defuser ? spike.defuse + dt : Math.max(0, spike.defuse - dt * 0.5);
    if (spike.defuse >= DEFUSE_SECONDS) {
      spike.state = 'defused';
      pushFeed(game, `${defuser.name} defused the spike`, 'defend');
    }
  }
}

// ---------- results ----------

function checkResult(game) {
  const spike = game.spike;
  let result = null;
  if (!aliveTeam(game, 'attack').length && spike.state !== 'planted') result = { winner: 'defend', reason: 'Attackers eliminated' };
  else if (!aliveTeam(game, 'defend').length) result = { winner: 'attack', reason: 'Defenders eliminated' };
  else if (spike.state === 'defused') result = { winner: 'defend', reason: 'The spike was defused' };
  else if (spike.state === 'planted' && spike.timer <= 0) result = { winner: 'attack', reason: `Spike detonated on ${spike.site}` };
  else if (spike.state !== 'planted' && game.time >= ROUND_SECONDS) result = { winner: 'defend', reason: 'Time ran out before the plant' };
  if (result) game.result = { ...result, time: game.time };
}

export function roundStatus(game, team) {
  const spike = game.spike;
  if (spike.state === 'planted') return { clock: spike.timer, label: `Spike planted on ${spike.site}` };
  if (team === 'defend') return { clock: ROUND_SECONDS - game.time, label: 'Stop the plant' };
  if (spike.state === 'dropped') return { clock: ROUND_SECONDS - game.time, label: 'Spike dropped' };
  return { clock: ROUND_SECONDS - game.time, label: `Spike: ${unitById(game, spike.carrierId)?.name}` };
}

// What an agent is doing right now, in words. Takes a unit from a teamView.
export function actionLabel(u, enemyName) {
  if (!u.alive) return 'Down';
  if (u.plantProgress > 0) return 'Planting the spike';
  const where = u.orderLabel?.split('→ ')[1] ?? 'position';
  return {
    advance: `Moving to ${where}`,
    hold: `Holding ${where}`,
    fight: enemyName ? `Shooting ${enemyName}` : 'Fighting',
    cover: 'Taking cover',
    support: 'Helping a teammate',
    defuse: 'Defusing the spike',
    plant: 'Planting the spike',
    nade: 'Throwing a grenade',
    scatter: 'Getting clear of a grenade',
  }[u.action] ?? u.action;
}

// ---------- what one team is allowed to see ----------

// A plain, serializable snapshot of the game from one team's side (fog of war applied).
// Bot games render it directly; multiplayer sends it to each player.
export function teamView(game, team) {
  const intel = game.intel[team];
  const seenNow = id => game.time - (intel.get(id)?.t ?? -Infinity) < 0.15;
  const watchers = game.units.filter(u => u.team === team && u.alive);
  const units = [];
  for (const u of game.units) {
    if (u.team === team) units.push(ownUnit(game, u));
    else if (u.alive && seenNow(u.id)) {
      units.push({
        id: u.id, team: u.team, name: u.name, x: u.x, y: u.y, facing: u.facing, hp: u.hp, maxHp: u.maxHp, r: u.r,
        alive: true, color: ENEMY_COLORS[(u.slot ?? 0) % ENEMY_COLORS.length], firing: game.time - u.lastShotAt < 0.08,
        // Which of your agents can see them right now: the first-person view shows only what
        // the agent you're watching sees, and the team map shows everything anyone sees.
        seenBy: watchers.filter(w => w.visible.includes(u)).map(w => w.id),
      });
    }
  }
  const ghosts = [];
  for (const [id, i] of intel) {
    const age = game.time - i.t;
    if (age >= 0.15 && age < 3 && unitById(game, id)?.alive) ghosts.push({ id, x: i.x, y: i.y, age });
  }
  // Every enemy, whether or not you can see them: name and colour are fixed, and you always
  // know which ones you have killed. Health only while one of your agents has eyes on them.
  const roster = game.units.filter(u => u.team !== team).map(u => {
    const seen = u.alive && seenNow(u.id);
    return {
      id: u.id, name: u.name, slot: u.slot ?? 0,
      color: ENEMY_COLORS[(u.slot ?? 0) % ENEMY_COLORS.length],
      down: !u.alive && game.knownDown[team].has(u.id),
      seen,
      hp: seen ? u.hp / u.maxHp : null,
    };
  });

  return {
    team,
    roster,
    time: game.time,
    result: game.result,
    status: roundStatus(game, team),
    units,
    ghosts,
    effects: game.effects.map(e => ({ ...e })),
    // Grenades are loud and visible, so both sides see them.
    grenades: game.grenades.map(g => ({ id: g.id, x: g.x, y: g.y, team: g.team, landed: Boolean(g.explodeAt), fuse: g.explodeAt ? Math.max(0, g.explodeAt - game.time) : 0 })),
    spike: spikeView(game, team),
    feed: game.feed.filter(f => (f.audience === 'all' || f.audience === team) && game.time - f.t < 8).slice(-5),
  };
}

function ownUnit(game, u) {
  const carrying = game.spike.state === 'carried' && game.spike.carrierId === u.id;
  return {
    id: u.id, team: u.team, name: u.name, kind: u.kind, x: u.x, y: u.y, facing: u.facing,
    color: OWN_COLORS[(u.slot ?? 0) % OWN_COLORS.length],
    hp: u.hp, maxHp: u.maxHp, r: u.r, alive: u.alive, moving: u.moving, action: u.action, grenades: u.grenades,
    firing: game.time - u.lastShotAt < 0.08,
    orderLabel: u.order ? orderLabel(u) : null,
    dest: u.alive && u.order ? orderDestination(game, u) : null,
    decision: u.decision ?? null,
    carrying,
    plantProgress: carrying ? game.spike.progress / PLANT_SECONDS : 0,
  };
}

function spikeView(game, team) {
  const s = game.spike;
  if (s.state === 'planted') return { state: 'planted', x: s.x, y: s.y, site: s.site, timer: s.timer, defuse: s.defuse / DEFUSE_SECONDS };
  if (team !== 'attack') return { state: 'unknown' };
  if (s.state === 'dropped') return { state: 'dropped', x: s.x, y: s.y };
  return { state: s.state, carrierId: s.carrierId };
}
