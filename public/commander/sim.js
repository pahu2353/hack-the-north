// Spike Rush simulation: attackers vs defenders, five each. A team is either commanded by a
// player (agents steered by Jev) or bots executing scripted/OpenAI objectives. Runs in the
// browser for bot games and on the server for multiplayer.
import { defenderCombat, opponentDestination, updateOpponentTactics } from './opponent.js';
import {
  MAPS, angleDiff, angleTo, blockedAt, buildGrid, castRay, clamp, dist, findPath, hasLineOfSight,
  nearestOpenPoint, walkableLine, zoneAt, zoneByName,
} from './world.js';

export const TEAMS = {
  attack: { label: 'Attackers', names: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'] },
  defend: { label: 'Defenders', names: ['Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett'] },
};
export const otherTeam = team => (team === 'attack' ? 'defend' : 'attack');

// One colour per agent, in squad order, so an agent looks the same on the top bar, the map,
// the first-person view and their card. Always from the viewer's side: yours blue, theirs red.
// Four shades of one hue per side. They stay light enough to read as text on the dark panel
// and to take dark lettering inside a filled chip.
export const OWN_COLORS = ['#d3e8ff', '#96c6ff', '#59a0f7', '#3a7fdd', '#2b62b4'];
export const ENEMY_COLORS = ['#ffd2cc', '#ffa79c', '#f4705f', '#dc4a37', '#b23524'];

// Rifles take six hits to kill, and automatic fire misses often. Fights last long
// enough that positioning and grenades decide them rather than whoever fires first.
export const MAX_HP = 150;
export const RIFLE = { range: 45, damage: 28, interval: 0.22, accuracy: 0.38 };
// Hard opponents get a modest combat advantage to challenge first-person aim assistance.
// This profile belongs only to bot-mode opponents, including during a planner outage.
export const HARD_BOT = { hp: 175, accuracy: 0.5, speed: 5, reaction: 0.25 };
// First-person aim boosts automatic accuracy only on the enemy under the crosshair.
// These chances still lose accuracy over distance and against moving targets.
// Dimensions match the renderer; damage, reaction time and fire rate stay the same.
export const MANUAL_AIM = {
  eye: 1.6, height: 1.8, halfWidth: 0.375, maxPitch: Math.PI / 4,
  accuracy: 0.7, movingAccuracy: 0.5, lease: 0.6,
};
const SIGHT = 45;
const PLANT_SECONDS = 3;
const DEFUSE_SECONDS = 6;
export const ROUND_SECONDS = 100;
// Ten seconds to place the squad before the round starts. You can move, but not past your
// own third of the map, so nobody can be standing on the enemy's site when it begins.
export const PREP_SECONDS = 10;
export const PREP_SHARE = 0.3;
export const preparing = game => game.time < (game.liveAt ?? 0);
export const roundClock = game => Math.max(0, game.time - (game.liveAt ?? 0));
// The line a team may not cross during prep (attackers hold the high-y end of the map).
export const prepLine = (map, team) => (team === 'attack' ? map.height * (1 - PREP_SHARE) : map.height * PREP_SHARE);
const SPIKE_SECONDS = 35;
// Fallback for a map that doesn't name its own rotation posts.
const ROTATE_SPOTS = [{ x: 16, y: 10 }, { x: 64, y: 10 }];
// A fresh order is carried out first and argued with later: for this long the agent does what
// it was told, and Jev isn't asked. The one exception is diving away from a live grenade.
const OBEY_SECONDS = 3;
// Grenades are the answer to a squad that just walks around as one clump: one throw reaches
// everyone standing together. The fuse is long enough that Jev can decide to scatter in time.
export const GRENADE = {
  carried: 1, range: 26, radius: 6, centreDamage: 85, edgeDamage: 30,
  speed: 17, fuse: 1.5, cooldown: 1.5, clusterGap: 5,
};
const TRACK_MAX_SPEED = 8; // reject teleports/collision spikes in observed movement
// Agents sent to the same zone each take their own spot around its centre; if they all aimed
// for the same point they'd shove each other forever (and a carrier that never stops can't plant).
const SLOTS = [{ x: 0, y: 0 }, { x: 2.2, y: 0.6 }, { x: -2.2, y: 0.6 }, { x: 1.1, y: 2.4 }, { x: -1.1, y: 2.4 }];

// How fast a body moves, as a fraction of its own speed. Walking is the tactical pace: slow
// enough to stay accurate and to clear an angle properly, which is what a commander means by
// "carefully" even when they never say the word.
export const PACE = { still: 0, walk: 0.45, run: 1 };
// How far apart a squad sent to one zone stands. One grenade reaches everyone in a clump, so
// spreading is the answer to being punished for arriving together; stacking is for going
// through a door fast and is worth the risk when the order was urgent.
export const FORMATION = { stacked: 0.55, normal: 1, spread: 2.1 };
// Where an agent points its weapon, which until now was wherever it last walked. Travel is the
// old behaviour; the rest are what a player does with the mouse while their feet do something
// else, and they are the difference between a squad standing around and a squad holding a site.
export const GAZE = ['travel', 'hold_angle', 'on_threat', 'scan', 'watch_back'];
// A scan sweeps this far either side of the angle being held, slowly, like checking a corner.
const SCAN_ARC = 0.85;
const SCAN_RATE = 0.9;
// Roles inside a group given one order. Two agents sent to the same place should not behave
// identically: someone goes through the door and someone covers them going through it.
export const ROLES = ['entry', 'trade', 'anchor', 'lurk'];
// An order lands visibly before anyone has walked anywhere: the agent looks where it was sent.
// Almost all of the felt responsiveness of an order is in this half second.
const ACK_SECONDS = 0.45;
// How long an agent that has arrived stays put before looking for a better spot in the same
// zone. Occupying ground is a job, not the absence of one.
const OCCUPY_SETTLE = 2.5;

// defenders selects bot mode or multiplayer; playerTeam chooses the human's side in bot mode.
// A match is a best of three. It keeps the score and every agent's totals, so a round can
// end and the next one starts with fresh bodies but the same scorecard.
export function createMatch({ bestOf = 3, playerTeam = 'attack' } = {}) {
  return {
    bestOf,
    needed: Math.floor(bestOf / 2) + 1,
    playerTeam,
    score: { attack: 0, defend: 0 },
    rounds: [],
    stats: {},
    over: false,
    winner: null,
  };
}

// Totals for one agent, created the first time they appear.
function matchStats(match, unit) {
  match.stats[unit.name] ??= { name: unit.name, team: unit.team, slot: unit.slot ?? 0, kills: 0, deaths: 0, damage: 0 };
  return match.stats[unit.name];
}

// The scoreboard as it stands right now: finished rounds plus the round in progress.
export function liveScorecard(game, team) {
  const rows = new Map(scorecard(game.match, team).map(row => [row.name, row]));
  for (const u of teamUnits(game, team)) {
    const row = rows.get(u.name) ?? { name: u.name, team, slot: u.slot ?? 0, kills: 0, deaths: 0, damage: 0 };
    if (!game.roundRecorded) {
      row.kills += u.stats.kills;
      row.deaths += u.stats.deaths;
      row.damage += Math.round(u.stats.damage);
    }
    row.alive = u.alive;
    rows.set(u.name, row);
  }
  return [...rows.values()].sort((a, b) => a.slot - b.slot);
}

export function scorecard(match, team) {
  return Object.values(match.stats)
    .filter(row => row.team === team)
    .sort((a, b) => a.slot - b.slot)
    .map(row => ({ ...row }));
}

// Fold a finished round into the match: the score, and each agent's kills, deaths and damage.
function finishRound(game) {
  const match = game.match;
  if (!match || game.roundRecorded) return;
  game.roundRecorded = true;
  for (const u of game.units) {
    const row = matchStats(match, u);
    row.kills += u.stats.kills;
    row.deaths += u.stats.deaths;
    row.damage += Math.round(u.stats.damage);
  }
  match.score[game.result.winner]++;
  match.rounds.push({ winner: game.result.winner, reason: game.result.reason, seconds: Math.round(game.result.time) });
  if (match.score[game.result.winner] >= match.needed) {
    match.over = true;
    match.winner = game.result.winner;
  }
}

// A disconnect ends the match, even between rounds. Record an unfinished round once;
// a forfeit during the scoreboard must preserve the round that was already won.
export function forfeitMatch(game, winner, reason) {
  if (game.match.over) return;
  if (!game.result) {
    game.result = { winner, reason, time: game.time };
    finishRound(game);
  }
  game.match.over = true;
  game.match.winner = winner;
  game.match.reason = reason;
}

// prep: start with the ten-second setup phase. Real rounds ask for it; tests that set up a
// situation and step a second or two start live.
export function createGame({ defenders = 'bots', opponent = 'scripted', playerTeam = 'attack', match = null, prep = false, map: mapId = 'tactical' } = {}) {
  const map = MAPS[mapId] ?? MAPS.tactical;
  const game = {
    map,
    defenders,
    match: match ?? createMatch({ playerTeam }),
    roundRecorded: false,
    botTeam: defenders === 'bots' ? otherTeam(playerTeam) : null,
    opponent: defenders === 'bots' ? opponent : 'scripted',
    grids: new Map(),
    time: 0,
    liveAt: prep ? PREP_SECONDS : 0, // when the round itself starts
    units: [],
    effects: [],
    feed: [],
    result: null,
    nextId: 1,
    intel: { attack: new Map(), defend: new Map() },
    grenades: [],
    knownDown: { attack: new Set(), defend: new Set() },
    manualAim: { attack: null, defend: null },
    // What the commander said about the enemy without giving an order. "Two on B" is not a
    // command and correctly does not move anyone, but a squad that hears it and changes
    // nothing at all is a squad that is not listening.
    callouts: { attack: null, defend: null },
  };
  for (const team of ['attack', 'defend']) map.spawns[team].forEach((post, i) => {
    if (team === game.botTeam) {
      const hard = game.opponent === 'openai';
      const hp = hard ? HARD_BOT.hp : MAX_HP;
      game.units.push(makeUnit(game, {
        team, kind: 'bot', name: `E${i + 1}`, slot: i, x: post.x, y: post.y, post, r: 0.6, hp, maxHp: hp,
        speed: hard ? HARD_BOT.speed : 4.5, reaction: hard ? HARD_BOT.reaction : 0.28 + Math.random() * 0.12,
        facing: team === 'attack' ? -Math.PI / 2 : Math.PI / 2,
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
    team, kind: 'agent', name, slot, x: at.x, y: at.y, r: 0.6, hp: MAX_HP, maxHp: MAX_HP, speed: 5, reaction: 0.25,
    facing: team === 'attack' ? -Math.PI / 2 : Math.PI / 2,
    action: 'hold', focusId: null, decision: null,
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
    lastAimHitAt: -Infinity,
    stillSince: 0,
    pace: 'run',
    gaze: 'travel',
    holdBearing: null,
    scanPhase: Math.random() * Math.PI * 2,
    holdFire: false,
    role: null,
    occupying: false,
    ackUntil: 0,
    repositionPoint: null,
    settleAt: 0,
    stats: { kills: 0, deaths: 0, damage: 0 },
    grenades: GRENADE.carried,
    throwReadyAt: 0,
    ...props,
  };
}

// What an agent does before the commander says anything: nothing. Both squads hold where they
// spawned until they are told otherwise. Attackers used to rush whichever site was nearer the
// squad, which on a centred spawn is a tie decided by a fraction of a metre — so every round
// opened with the same unasked-for commitment to the same site. The setup phase is there for
// the commander to place the squad; the first order should be the first tactical decision.
export function defaultOrder(game, u) {
  return { type: 'hold', zone: zoneAt(game.map, u).name, point: { x: u.x, y: u.y } };
}

export const teamUnits = (game, team) => game.units.filter(u => u.team === team);
export const aliveTeam = (game, team) => game.units.filter(u => u.team === team && u.alive);
export const unitById = (game, id) => game.units.find(u => u.id === id);

// Where the enemy is, as far as this team knows: the freshest sighting any of them has. It is
// what "go at them" means, and it stays inside the fog of war — an unseen enemy is not here.
// With nothing seen all round, the enemy's own spawn is the honest direction to head.
export const CALLOUT_SECONDS = 20; // how long "they're on B" keeps steering the squad

// Where the enemy is, as far as this team knows. A commander's callout counts as knowing:
// it is worth exactly as much as a sighting of the same age, and no more, so a live sighting
// of somewhere else still wins.
export function noteCallout(game, team, point) {
  if (!point || !Object.hasOwn(game.callouts, team)) return false;
  game.callouts[team] = { x: point.x, y: point.y, t: game.time };
  return true;
}

export function enemyContact(game, team) {
  let best = null;
  for (const [id, seen] of game.intel[team]) {
    if (!unitById(game, id)?.alive) continue;
    if (!best || seen.t > best.t) best = seen;
  }
  const called = game.callouts?.[team];
  if (called && game.time - called.t < CALLOUT_SECONDS && (!best || called.t > best.t)) best = called;
  if (best) return { x: best.x, y: best.y, seenAgo: game.time - best.t };
  // Every map names its own spawns — Dust II calls them T and CT — so ask the map rather
  // than assuming the default layout's wording.
  const spawn = zoneByName(game.map, game.map.home[otherTeam(team)]);
  return { x: spawn.center.x, y: spawn.center.y, seenAgo: null };
}

function gridFor(game) {
  if (!game.grids.has('agent')) game.grids.set('agent', buildGrid(game.map, 0.7));
  return game.grids.get('agent');
}

// ---------- orders ----------

export function setOrder(game, u, order) {
  const o = { ...order, via: null, viaReached: false };
  o.spread ??= 'normal';
  const zoneCenter = zoneByName(game.map, o.zone)?.center;
  // Slots only apply to a whole zone. A point the commander actually picked — by clicking or
  // by pointing at it — is where they want the agent, so it is left exactly where it is.
  if (zoneCenter && dist(zoneCenter, o.point) < 0.01) {
    const slot = SLOTS[TEAMS[u.team].names.indexOf(u.name)] ?? SLOTS[0];
    const apart = FORMATION[o.spread] ?? 1;
    o.point = nearestOpenPoint(gridFor(game), { x: o.point.x + slot.x * apart, y: o.point.y + slot.y * apart });
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
  u.obeyUntil = game.time + OBEY_SECONDS;
  u.path = [];
  u.pathGoal = null;
  u.coverPoint = null;
  u.settledAt = null; // a new order is worth walking for, even onto a crowded spot
  u.approach = null;
  // A new order is a new job: whatever angle was being held belongs to the last one.
  u.occupying = false;
  u.holdBearing = null;
  u.repositionPoint = null;
  u.settleAt = 0;
  u.pace = o.pace ?? 'run';
  if (o.role !== undefined) u.role = o.role;
  u.holdFire = u.role === 'lurk';
  // Look where you were sent, now, before a single step is taken. The order has visibly
  // landed even though the walk has not started.
  u.gaze = 'travel';
  u.ackUntil = game.time + ACK_SECONDS;
}

// The direction an order points an agent in, used for the acknowledging turn and as the
// angle they end up holding once they arrive.
function orderBearing(game, u) {
  const dest = orderDestination(game, u);
  return dist(u, dest) > 0.5 ? angleTo(u, dest) : u.facing;
}

// What carrying out the current order looks like, as an action.
export function orderAction(game, u) {
  if (u.order.type === 'grenade') return 'nade';
  if (u.order.type === 'hold' && dist(u, orderDestination(game, u)) <= 3) return 'hold';
  return 'advance';
}
export const obeying = (game, u) => game.time < (u.obeyUntil ?? 0);

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

// ---------- directional orders ----------

// "Move right" is a pointer the commander describes in words instead of with their hand, so it
// resolves against what they are looking at, never against the agent's own facing: shoot()
// snaps that to whatever it is firing at, so "right" would mean something new every second and
// the commander cannot see it anyway. The client sends the world angle its view calls forward —
// screen-up on the map (which the defending side draws rotated), the camera in first person —
// and everything here is that angle turned by a quarter.
export const NUDGE = 7; // metres: enough to change an angle or clear a corner, not a rotation
const TURN = { forward: 0, right: Math.PI / 2, back: Math.PI, left: -Math.PI / 2 };
export const isDirection = value => Object.hasOwn(TURN, value);

// A step that direction, shortened until it is a walk rather than a trip around the building.
// Nothing that way means stay put: a nudge into a wall should do nothing, not path 40 m around.
export function directionPoint(game, u, yaw, direction) {
  const angle = yaw + TURN[direction];
  const grid = gridFor(game);
  for (let d = NUDGE; d >= 2; d--) {
    const p = {
      x: clamp(u.x + Math.cos(angle) * d, 1, game.map.width - 1),
      y: clamp(u.y + Math.sin(angle) * d, 1, game.map.height - 1),
    };
    if (walkableLine(grid, u, p)) return p;
  }
  return { x: u.x, y: u.y };
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
  if (preparing(game)) holdBehindPrepLine(game);
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
    for (const other of visible) {
      const previous = game.intel[u.team].get(other.id);
      if (previous?.t === game.time) continue; // one observation per team per simulation step
      const elapsed = game.time - (previous?.t ?? -Infinity);
      const continuous = elapsed > 0 && elapsed <= 0.25;
      const vx = continuous ? (other.x - previous.x) / elapsed : 0;
      const vy = continuous ? (other.y - previous.y) / elapsed : 0;
      const tracked = continuous && Math.hypot(vx, vy) <= TRACK_MAX_SPEED;
      game.intel[u.team].set(other.id, {
        x: other.x, y: other.y, t: game.time,
        vx: tracked ? vx * 0.6 + (previous.vx ?? 0) * 0.4 : 0,
        vy: tracked ? vy * 0.6 + (previous.vy ?? 0) * 0.4 : 0,
        trackedFor: tracked ? Math.min(1, (previous.trackedFor ?? 0) + elapsed) : 0,
      });
    }
  }
}

// ---------- agents (Jev picks u.action; this executes it every frame) ----------

function controlAgent(game, u, dt) {
  const focus = crosshairTarget(game, u) ?? u.visible.find(e => e.id === u.focusId) ?? u.visible[0] ?? null;
  // Your order comes first: while it is fresh the agent simply carries it out. A grenade
  // about to go off is the one thing worth asking Jev about, so that decision is left alone.
  if (obeying(game, u) && !incomingGrenade(game, u)) {
    u.action = orderAction(game, u);
  }
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
      else if (throwGrenade(game, u, target.spot)) {
        dest = null;
        // The order was "grenade that spot", and it is done: hold here instead of re-throwing.
        if (u.order.type === 'grenade') setOrder(game, u, { type: 'hold', zone: zoneAt(game.map, u).name, point: { x: u.x, y: u.y } });
      } else dest = target.spot; // out of range or no line: walk it in
      break;
    }
    case 'scatter': {
      const bomb = incomingGrenade(game, u);
      dest = bomb ? evadePoint(game, u, bomb) : objective;
      break;
    }
    case 'reposition': {
      // Same ground, better spot. The relation is chosen here rather than asked for as a
      // coordinate, because a model naming "off the angle they are watching" is reliable and
      // a model naming a pair of metres is not.
      if (!u.repositionPoint || dist(u, u.repositionPoint) < 1) u.repositionPoint = betterSpot(game, u, focus);
      dest = u.repositionPoint;
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
  // Somewhere to be and told to stand still is a contradiction: the order wins, at the
  // careful pace. Code resolves it rather than letting a stuck agent look like a bug.
  if (dest && u.pace === 'still') u.pace = 'walk';
  // Arrived, with nothing to fight: occupying ground is a job of its own, and it is the one
  // the squad spends most of a round doing.
  if (!dest && !focus) occupy(game, u, focus);
  else if (dest) u.occupying = false;
  moveToward(game, u, dest, dt);
  aimAgent(game, u, focus, dt);
  if (focus) shoot(game, u, focus);
}

// A better place to stand than this one, expressed as a relation rather than a coordinate.
// Off the angle a visible enemy is watching if there is one; otherwise a spot in the same
// zone that is not on top of a teammate, which is what stops a squad bunching into one grenade.
function betterSpot(game, u, focus) {
  const g = gridFor(game);
  const zone = zoneAt(game.map, u);
  const mates = aliveTeam(game, u.team).filter(m => m !== u);
  const away = focus ? angleTo(focus, u) : null;
  let best = null;
  let bestScore = -Infinity;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const radius = 2.5 + (k % 3) * 1.6;
    const p = { x: u.x + Math.cos(a) * radius, y: u.y + Math.sin(a) * radius };
    if (p.x < 1 || p.y < 1 || p.x > game.map.width - 1 || p.y > game.map.height - 1) continue;
    if (!walkableLine(g, u, p)) continue;
    if (zoneAt(game.map, p) !== zone) continue; // repositioning is within the ground you hold
    // Spacing from the squad first: one grenade should not be able to reach two of you.
    let score = mates.length ? Math.min(...mates.map(m => dist(m, p))) : 6;
    // Off the angle, not straight back from it: sidestepping beats retreating in a straight line.
    if (away !== null) score += Math.abs(Math.sin(a - away)) * 4 - (hasLineOfSight(game.map, focus, p) ? 3 : 0);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best ?? { x: u.x, y: u.y };
}

// Somewhere clear of a blast, in the walkable direction away from it. A grenade landing right
// at your feet has no "away", so run from the squad instead, which also breaks up the clump.
function evadePoint(game, u, from) {
  const squad = aliveTeam(game, u.team).filter(m => m !== u);
  const reference = dist(from, u) > 0.5 || !squad.length ? from : average(squad);
  const away = dist(reference, u) > 0.1 ? angleTo(reference, u) : Math.random() * Math.PI * 2;
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

// Only camera direction comes from a client. Shooting always stays automatic.
// A short lease removes the accuracy bonus if a tab stops sending aim updates.
export function setManualAim(game, team, input) {
  if (!Object.hasOwn(game.manualAim, team)) return false;
  if (input === null) { game.manualAim[team] = null; return true; }
  if (game.result || !input || !Number.isInteger(input.unitId)
      || !Number.isFinite(input.yaw) || !Number.isFinite(input.pitch)
      || Math.abs(input.pitch) > MANUAL_AIM.maxPitch) return false;
  const u = unitById(game, input.unitId);
  if (!u?.alive || u.team !== team || u.kind !== 'agent') return false;
  game.manualAim[team] = {
    unitId: u.id, yaw: Math.atan2(Math.sin(input.yaw), Math.cos(input.yaw)), pitch: input.pitch,
    expiresAt: game.time + MANUAL_AIM.lease,
  };
  return true;
}

export function manualAimFor(game, u) {
  const aim = game.manualAim[u.team];
  return !game.result && u.alive && aim?.unitId === u.id && aim.expiresAt > game.time ? aim : null;
}

export function crosshairTarget(game, u) {
  const aim = manualAimFor(game, u);
  if (!aim) return null;
  const dx = Math.cos(aim.yaw), dy = Math.sin(aim.yaw);
  let reach = Math.min(RIFLE.range, castRay(game.map.walls, u.x, u.y, dx, dy)?.t ?? Infinity);
  let target = null;
  // Match the billboard's width/height. Nearest enemy stops the bullet; walls always block.
  for (const e of u.visible) {
    if (!e.alive || dist(u, e) > RIFLE.range) continue;
    const x = e.x - u.x, y = e.y - u.y;
    const along = x * dx + y * dy;
    const across = -x * dy + y * dx;
    const height = MANUAL_AIM.eye + Math.tan(aim.pitch) * along;
    if (along > 0 && along < reach && Math.abs(across) <= MANUAL_AIM.halfWidth
        && height >= 0 && height <= MANUAL_AIM.height) {
      target = e;
      reach = along;
    }
  }
  return target;
}

export function rifleAccuracy(game, u, target) {
  let p;
  if (crosshairTarget(game, u) === target) {
    // The aimed standing chance already includes steadiness; don't stack the idle bonus.
    p = u.moving ? MANUAL_AIM.movingAccuracy : MANUAL_AIM.accuracy;
  } else {
    p = u.kind === 'bot' && game.opponent === 'openai' ? HARD_BOT.accuracy : RIFLE.accuracy;
    // Running spoils your aim; walking barely does. That gap is what makes "take it slow"
    // a real instruction rather than a slower way to arrive.
    if (u.moving) p *= u.pace === 'walk' ? 0.65 : 0.3;
    else if (game.time - u.stillSince > 1) p *= 1.25;
  }
  p *= clamp(1 - dist(u, target) / 55, 0.15, 1);
  if (target.moving) p *= 0.8;
  return p;
}

function shoot(game, u, target) {
  if (u.cooldown > 0 || !target.alive || preparing(game)) return;
  // Holding fire is what makes an ambush, a lurk and letting someone walk past possible at
  // all. It is never suicide: an agent already being shot at, or about to be walked into,
  // defends itself and gives its position away.
  if (u.holdFire && !(target.targetId === u.id && game.time - target.lastShotAt < 1) && dist(u, target) > 6) return;
  if (game.time - (u.seen.get(target.id) ?? game.time) < u.reaction) return;
  const d = dist(u, target);
  if (d > RIFLE.range) return;
  u.cooldown = RIFLE.interval;
  u.facing = angleTo(u, target);
  u.targetId = target.id;
  u.lastShotAt = game.time;
  // Normal automatic fire loses 70% accuracy while moving; crosshair assistance is tighter.
  const hit = Math.random() < rifleAccuracy(game, u, target);
  const miss = hit ? 0 : (Math.random() - 0.5) * 3;
  game.effects.push({
    kind: 'tracer', team: u.team, ttl: 0.08,
    x1: u.x, y1: u.y, x2: target.x + miss, y2: target.y - miss,
  });
  if (hit) {
    if (crosshairTarget(game, u) === target) u.lastAimHitAt = game.time;
    damage(game, target, RIFLE.damage, u);
  }
}

function damage(game, target, amount, source) {
  if (!target.alive) return;
  source.stats && (source.stats.damage += Math.min(amount, target.hp));
  target.hp -= amount;
  target.lastHitAt = game.time;
  if (target.hp > 0) return;
  target.hp = 0;
  target.alive = false;
  target.moving = false;
  target.stats.deaths++;
  if (source.stats && source.team !== target.team) source.stats.kills++;
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
  dest = clampToPrep(game, u, dest);
  if (!dest) {
    u.moving = false;
    return;
  }
  // Already given up on this destination because teammates are standing on it. Squads are sent
  // to one point all the time ("everyone push B"), and the slot offsets can still collapse onto
  // each other in a corner, so without this the last arrivals shove the others off the spot and
  // walk back in, forever. It lasts only as long as the crowd does: once the spot clears, the
  // agent goes and takes it.
  if (u.settledAt && dist(dest, u.settledAt) < 0.5) {
    if (touching(game, u)) {
      u.moving = false;
      return;
    }
    u.settledAt = null;
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
  u.travelHeading = heading;
  // Facing follows the feet only while the agent is travelling with its eyes forward. Any
  // other gaze means the two have deliberately come apart, and aimAgent owns the angle.
  if (game.time - u.lastShotAt > 0.4 && u.gaze === 'travel' && game.time >= (u.ackUntil ?? 0)) {
    u.facing = turnToward(u.facing, heading, dt);
  }
  const distance = Math.min(paceSpeed(u) * dt, dist(u, waypoint));
  const moved = advance(game, u, heading, distance);
  u.moving = moved > 0.001;
  noteProgress(game, u, dest);
}

// Whether the agent is actually getting anywhere, measured against the destination rather than
// against the step it asked for. The shoving that makes a crowd vibrate happens in the
// collision pass, after this one, so a step can be granted in full and then be undone; only the
// distance still to go tells the truth. No progress for this long means something is in the way.
const STALLED_SECONDS = 0.6;
const PROGRESS = 0.3; // metres of closing that count as getting somewhere
// Close enough to count as arrived when a teammate is already standing on the spot. Kept under
// the 1.5 m a defuser has to be within, so settling can never talk an agent out of the defuse.
const CROWDED_ENOUGH = 1.2;
const touching = (game, u) => game.units.some(o =>
  o !== u && o.alive && o.team === u.team && dist(o, u) < (u.r + o.r) * 1.35);

function noteProgress(game, u, dest) {
  const toGo = dist(u, dest);
  if (!u.approach || dist(u.approach.dest, dest) > 0.5 || toGo < u.approach.best - PROGRESS) {
    u.approach = { dest: { x: dest.x, y: dest.y }, best: toGo, since: game.time };
    return;
  }
  if (game.time - u.approach.since < STALLED_SECONDS) return;
  // Stalled. A teammate on the spot means the spot is taken — stop, we are close enough, rather
  // than shoving them off it and walking back in for the rest of the round. Anything else means
  // the route is wrong, so ask for a new one.
  if (toGo < CROWDED_ENOUGH && touching(game, u)) u.settledAt = { x: dest.x, y: dest.y };
  else u.repathAt = 0;
  u.approach.since = game.time;
}

// Walking straight into a wall used to work like this: the step went in, the collision pass
// snapped the agent back out, and the next frame started the same step again. The agent stood
// there vibrating, and its heading — and so the model, the view cone and the first-person
// camera — snapped back and forth with it. Slide instead: drop whichever axis of the step is
// blocked and keep the other, the way a person brushes along a wall. Returns how far it got.
function advance(game, u, heading, distance) {
  const dx = Math.cos(heading) * distance;
  const dy = Math.sin(heading) * distance;
  if (!blockedAt(game.map, u.x + dx, u.y + dy, u.r)) {
    u.x += dx;
    u.y += dy;
    return distance;
  }
  if (!blockedAt(game.map, u.x + dx, u.y, u.r)) {
    u.x += dx;
    return Math.abs(dx);
  }
  if (!blockedAt(game.map, u.x, u.y + dy, u.r)) {
    u.y += dy;
    return Math.abs(dy);
  }
  return 0;
}

// Aiming and throwing snap the agent round on purpose; walking does not. Capping how fast a
// walking agent can turn keeps one frame's shove — from a wall, or from a teammate squeezing
// past — from spinning it on the spot.
const TURN_RATE = 10; // radians per second
// ---------- where the weapon points ----------

// Until now facing was wherever the agent last walked, so a squad that arrived somewhere stood
// staring at the wall it had approached. Facing is now its own decision, and the gaze channel
// is what decides it: the feet carry out the order while the eyes hold an angle, sweep a
// corner, or watch the way the squad came in.
function aimAgent(game, u, focus, dt) {
  // A shot just snapped the weapon onto its target; nothing overrides that.
  if (game.time - u.lastShotAt <= 0.4) return;
  // An order has landed. Look at it before a step is taken — including while standing still,
  // where nothing used to move the angle at all. This is most of what makes an order feel
  // like it was heard. The turn stays at the normal bounded rate: 10 rad/s is already a
  // snap, and exceeding it is what lets a shove spin an agent.
  if (game.time < (u.ackUntil ?? 0)) {
    u.facing = turnToward(u.facing, orderBearing(game, u), dt);
    return;
  }
  const want = gazeBearing(game, u, focus, dt);
  if (want !== null) u.facing = turnToward(u.facing, want, dt);
}

function gazeBearing(game, u, focus, dt) {
  const fallback = u.holdBearing ?? null;
  switch (u.gaze) {
    case 'on_threat': {
      const at = focus ?? (game.intel[u.team].size ? enemyContact(game, u.team) : null);
      return at ? angleTo(u, at) : fallback;
    }
    case 'hold_angle':
      return fallback;
    case 'scan': {
      // A slow sweep either side of the angle being held, the way you check a corner you are
      // not committed to. Never a spin: the held angle stays the centre of attention.
      u.scanPhase += dt * SCAN_RATE;
      const base = u.holdBearing ?? u.facing;
      return base + Math.sin(u.scanPhase) * SCAN_ARC;
    }
    case 'watch_back':
      // Looking back down the way the squad came, which is where a flank arrives from.
      return angleTo(orderDestination(game, u), u);
    default:
      // Travelling: the feet own the angle while moving, the last held angle when stopped.
      return u.moving ? null : fallback;
  }
}

// An agent that has arrived is occupying ground, which is a job. It picks an angle worth
// holding — the way the enemy is known or expected to come — and keeps it.
function occupy(game, u, focus) {
  if (!u.occupying) {
    u.occupying = true;
    u.settleAt = game.time + OCCUPY_SETTLE;
    const threat = enemyContact(game, u.team);
    u.holdBearing = angleTo(u, threat);
    u.scanPhase = Math.random() * Math.PI * 2;
  }
  if (focus) return;
  // Nobody in sight and nothing to do: hold the angle, and sweep it when the order was to
  // hold rather than to take ground. A lurker keeps watching the way in behind them.
  if (u.role === 'lurk') u.gaze = 'watch_back';
  else if (u.gaze === 'travel') u.gaze = u.order.type === 'hold' ? 'scan' : 'hold_angle';
}

// Walking is a real tactical choice, not a slower run: it keeps the agent accurate and is
// what clearing an angle looks like. A pace of 'still' with somewhere to be is a contradiction
// the caller resolves before we get here, so it never freezes anyone mid-order.
export const paceSpeed = u => u.speed * (PACE[u.pace] ?? 1);

function turnToward(from, to, dt) {
  const step = TURN_RATE * dt;
  if (angleDiff(from, to) <= step) return to;
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  // Normalised, so a long run of turns the same way cannot walk the angle off to infinity.
  return Math.atan2(Math.sin(from + Math.sign(delta) * step), Math.cos(from + Math.sign(delta) * step));
}

// During prep a squad may walk around its own third of the map, and no further.
// During prep an agent's destination is pulled back to its own side, so it walks up to the line
// and stops. Without this it paths across, gets snapped back every frame, repaths, and vibrates.
function clampToPrep(game, u, dest) {
  if (!dest || !preparing(game)) return dest;
  const line = prepLine(game.map, u.team);
  const limit = u.team === 'attack' ? line + u.r + 0.2 : line - u.r - 0.2;
  const beyond = u.team === 'attack' ? dest.y < limit : dest.y > limit;
  if (!beyond) return dest;
  // The goal is across the line: walk up to it, then hold. Without the hold, the whole squad
  // presses on the same point and shoves each other sideways for the rest of the phase.
  const atLine = u.team === 'attack' ? u.y <= limit + 1.2 : u.y >= limit - 1.2;
  return atLine ? null : { x: dest.x, y: limit };
}

// A backstop for anything that still ends up over the line (a shove, a spawn). It no longer
// clears the path: that was the other half of the vibration.
function holdBehindPrepLine(game) {
  for (const u of game.units) {
    if (!u.alive) continue;
    const line = prepLine(game.map, u.team);
    if (u.team === 'attack' ? u.y < line : u.y > line) u.y = line + (u.team === 'attack' ? u.r : -u.r);
  }
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
  const targets = u.visible.filter(v => v.alive);
  // Finish exposed wounded enemies together instead of each bot duelling the nearest one.
  const focus = game.opponent === 'openai'
    ? targets.sort((a, b) => Math.ceil(a.hp / RIFLE.damage) - Math.ceil(b.hp / RIFLE.damage) || dist(u, a) - dist(u, b))[0]
    : targets[0];
  // Bots use grenades by rule: punish a group, and don't stand in one.
  // Keep clear until this blast is over, even after leaving the initial danger radius.
  // Otherwise a hold/regroup order can pull the bot straight back into the same grenade.
  const bomb = incomingGrenade(game, u) ?? game.grenades.find(g =>
    g.id === u.botDodge?.grenadeId && g.team !== u.team && g.explodeAt > game.time);
  if (bomb) {
    if (u.botDodge?.grenadeId !== bomb.id) {
      u.botDodge = { grenadeId: bomb.id, point: evadePoint(game, u, bomb) };
    }
    moveToward(game, u, dist(u, u.botDodge.point) < 0.5 ? null : u.botDodge.point, dt);
    if (focus) shoot(game, u, focus);
    return;
  }
  u.botDodge = null;
  // Throw before holding or falling back. Hard bots briefly track the group's movement
  // first, so their one grenade is not spent on an unobserved guess at first contact.
  if (u.grenades > 0) {
    const clump = grenadeSpot(game, u);
    if (clump && clump.caught >= 2 && (game.opponent !== 'openai' || clump.ready)) {
      throwGrenade(game, u, clump.spot);
    }
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
      || (u.hp < u.maxHp / 2 && combat.visibleEnemies > strength);
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
  if (planned && (group?.unitIds.includes(u.id) || u.botOrder.action === 'flank')) {
    // Retakes and flanks must keep moving through contact to complete the maneuver.
    // Grenade avoidance and the survival reflex above still take priority.
    moveToward(game, u, dist(u, planned) < 1.2 ? null : planned, dt);
    if (focus) shoot(game, u, focus);
    return;
  }
  if (focus) {
    // Outnumbered and hurt: fall back to cover instead of trading badly.
    if (u.hp < u.maxHp / 2 && u.visible.length >= 2) {
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
    const spots = game.map.rotateSpots ?? ROTATE_SPOTS;
    if (callout) dest = spots.reduce((a, b) => (dist(b, callout) < dist(a, callout) ? b : a));
  }
  if (dist(u, dest) < 1.2) dest = null;
  moveToward(game, u, dest, dt);
}

// ---------- grenades ----------

// The point that catches the most enemies: the middle of a group. Like a real player, this
// counts people seen a moment ago as well as right now, so a squad moving as one clump can be
// hit just after it ducks out of sight. Hard bots lead reliable observed movement.
export function grenadeSpot(game, u, memory = 2) {
  const lead = u.kind === 'bot' && game.opponent === 'openai';
  const marks = u.visible.filter(e => e.alive).map(e => ({ ...game.intel[u.team].get(e.id), x: e.x, y: e.y }));
  for (const [id, seen] of game.intel[u.team]) {
    const target = unitById(game, id);
    if (!target?.alive || target.team === u.team) continue;
    if (game.time - seen.t > memory || u.visible.some(v => v.id === id)) continue;
    marks.push({ ...seen });
  }
  if (marks.length < 2) return null;
  let best = null;
  for (const centre of marks) {
    const caught = marks.filter(m => dist(m, centre) <= GRENADE.clusterGap);
    let spot = average(caught);
    if (lead) {
      // Recalculate flight time as the aim point moves. Prediction uses observed velocity,
      // never an enemy's destination/path, and stops at walls instead of predicting turns.
      for (let i = 0; i < 3; i++) {
        const horizon = Math.max(0.35, dist(u, spot) / GRENADE.speed) + GRENADE.fuse;
        spot = average(caught.map(mark => predictGrenadeTarget(game, mark, horizon)));
      }
    }
    if (!hasLineOfSight(game.map, u, spot) || dist(u, spot) > GRENADE.range) continue;
    const horizon = Math.max(0.35, dist(u, spot) / GRENADE.speed) + GRENADE.fuse;
    const hits = lead ? marks.filter(mark => {
      const predicted = predictGrenadeTarget(game, mark, horizon);
      return dist(predicted, spot) <= GRENADE.clusterGap && hasLineOfSight(game.map, spot, predicted);
    }).length : caught.length;
    if ((!lead || hits >= 2) && (!best || hits > best.caught)) {
      best = { spot, caught: hits, ...(lead && { ready: caught.every(mark => mark.trackedFor >= 0.12) }) };
    }
  }
  return best;
}

function predictGrenadeTarget(game, mark, horizon) {
  const age = game.time - mark.t;
  // A fresh sighting needs several samples; lost contacts quickly lose reliable direction.
  if (!(mark.trackedFor >= 0.12) || age > 0.25) return { x: mark.x, y: mark.y };
  const seconds = Math.min(3.1, horizon + Math.max(0, age));
  const at = share => ({ x: mark.x + mark.vx * seconds * share, y: mark.y + mark.vy * seconds * share });
  const grid = gridFor(game);
  if (walkableLine(grid, mark, at(1))) return at(1);
  let lo = 0, hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (walkableLine(grid, mark, at(mid))) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

export function throwGrenade(game, u, point) {
  if (u.grenades < 1 || game.time < u.throwReadyAt || preparing(game)) return false;
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

// Only hostile, unshielded blasts are dangerous: grenades cannot hurt their own team.
export function incomingGrenade(game, u) {
  return game.grenades
    .filter(g => g.team !== u.team && g.explodeAt > game.time && dist(g, u) <= GRENADE.radius + 2
      && hasLineOfSight(game.map, g, u))
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
  // After a plant, surviving defenders still have until detonation to defuse. Losing the
  // attackers alone cannot end that round; losing both squads leaves nobody to defuse.
  if (spike.state === 'defused') result = { winner: 'defend', reason: 'The spike was defused' };
  else if (spike.state !== 'planted' && !aliveTeam(game, 'attack').length) result = { winner: 'defend', reason: 'Attackers eliminated' };
  else if (!aliveTeam(game, 'defend').length) result = { winner: 'attack', reason: 'Defenders eliminated' };
  else if (spike.state === 'planted' && spike.timer <= 0) result = { winner: 'attack', reason: `Spike detonated on ${spike.site}` };
  else if (spike.state !== 'planted' && roundClock(game) >= ROUND_SECONDS) result = { winner: 'defend', reason: 'Time ran out before the plant' };
  if (result) {
    game.result = { ...result, time: game.time };
    finishRound(game);
  }
}

export function roundStatus(game, team) {
  const spike = game.spike;
  if (preparing(game)) return { clock: game.liveAt - game.time, label: 'Get into position', prep: true };
  if (spike.state === 'planted') return { clock: spike.timer, label: `Spike planted on ${spike.site}` };
  const left = ROUND_SECONDS - roundClock(game);
  if (team === 'defend') return { clock: left, label: 'Stop the plant' };
  if (spike.state === 'dropped') return { clock: left, label: 'Spike dropped' };
  return { clock: left, label: `Spike: ${unitById(game, spike.carrierId)?.name}` };
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
        // Whether someone is walking or sprinting is visible from across a site, so sending
        // it leaks nothing the agent watching them cannot already see.
        moving: u.moving, pace: u.pace,
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
    mapId: game.map.id,
    time: game.time,
    result: game.result,
    status: roundStatus(game, team),
    prep: preparing(game) ? { line: prepLine(game.map, team), secondsLeft: game.liveAt - game.time } : null,
    match: {
      bestOf: game.match.bestOf,
      needed: game.match.needed,
      round: game.match.rounds.length + (game.result ? 0 : 1),
      score: { ...game.match.score },
      over: game.match.over,
      winner: game.match.winner,
      reason: game.match.reason ?? null,
      rounds: game.match.rounds.map(r => ({ ...r })),
      // Totals so far, plus what has happened in the round being played.
      scoreboard: Object.fromEntries(['attack', 'defend'].map(side => [side, liveScorecard(game, side)])),
    },
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
    pace: u.pace, gaze: u.gaze, role: u.role, holdFire: u.holdFire, occupying: u.occupying,
    obeying: obeying(game, u),
    manualAim: Boolean(manualAimFor(game, u)),
    aimTargetId: crosshairTarget(game, u)?.id ?? null,
    aimHit: game.time - u.lastAimHitAt < 0.15,
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
