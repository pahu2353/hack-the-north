import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import {
  KNIFE, MAX_HP, createGame, inView, orderDestination, paceSpeed, relativePoint,
  setOrder, setWeapon, slash, stepGame, teamUnits,
} from '../public/commander/sim.js';
import { CALLOUTS, MAPS, dist, zoneByName } from '../public/commander/world.js';

const STEP = 1 / 30;
const run = (game, seconds) => {
  for (let f = 0; f < Math.round(seconds / STEP); f++) stepGame(game, STEP);
};

// Two agents in open ground, everyone else parked out of the way.
function pair() {
  const game = createGame({ defenders: 'players', playerTeam: 'attack' });
  const a = teamUnits(game, 'attack')[0];
  const d = teamUnits(game, 'defend')[0];
  for (const u of game.units) { u.reaction = Infinity; u.speed = 0; u.obeyUntil = Infinity; }
  for (const u of game.units) if (u !== a && u !== d) Object.assign(u, { x: 2, y: 2 });
  Object.assign(a, { x: 40, y: 40, facing: -Math.PI / 2 });
  Object.assign(d, { x: 40, y: 38.5, facing: Math.PI / 2 });
  // Both holding where they stand. Without this they are still under their opening order
  // to hold at spawn, so the first simulated frame turns them to face it and every test
  // about where someone is looking measures the wrong thing.
  for (const u of [a, d]) {
    setOrder(game, u, { type: 'hold', zone: 'Mid', point: { x: u.x, y: u.y } });
    u.obeyUntil = Infinity;
    u.occupying = true;
    u.gaze = 'hold_angle';
    u.holdBearing = u.facing;
  }
  return { game, a, d };
}

test('a knife cuts what is in front of it and nothing that is not', () => {
  const { game, a, d } = pair();
  setWeapon(a, 'knife');
  // Standing behind the swing: outside the arc entirely.
  Object.assign(d, { x: 40, y: 41.5 });
  assert.equal(slash(game, a), false, 'nothing behind you is cut');
  assert.equal(d.hp, MAX_HP);

  // In front, inside reach.
  a.lastSlashAt = -Infinity;
  Object.assign(d, { x: 40, y: 38.5, facing: Math.PI / 2 });
  assert.ok(slash(game, a), 'someone in front of you is');
  assert.ok(d.hp < MAX_HP);
});

test('reach is real: a step too far and the swing misses', () => {
  const { game, a, d } = pair();
  setWeapon(a, 'knife');
  Object.assign(d, { x: 40, y: 40 - (KNIFE.range + d.r + 1) });
  assert.equal(slash(game, a), false, `nothing within ${KNIFE.range}m`);
  a.lastSlashAt = -Infinity;
  Object.assign(d, { x: 40, y: 40 - (KNIFE.range + d.r - 0.3) });
  assert.ok(slash(game, a), 'just inside reach connects');
});

test('from behind it kills outright, from the front it does not', () => {
  const stab = backTurned => {
    const { game, a, d } = pair();
    setWeapon(a, 'knife');
    // Facing away means facing the same way the attacker is.
    d.facing = backTurned ? -Math.PI / 2 : Math.PI / 2;
    slash(game, a);
    return d;
  };
  assert.equal(stab(true).alive, false, 'a backstab is lethal');
  const front = stab(false);
  assert.ok(front.alive, 'facing them, you survive it');
  assert.equal(front.hp, MAX_HP - KNIFE.damage);
});

test('a wall stops a swing', () => {
  const { game, a, d } = pair();
  setWeapon(a, 'knife');
  // Either side of the mid cover block (x 37-43, y 28-30).
  Object.assign(a, { x: 40, y: 30.6, facing: -Math.PI / 2 });
  Object.assign(d, { x: 40, y: 29, facing: Math.PI / 2 });
  assert.equal(slash(game, a), false, 'you cannot stab through a wall');
});

test('you move faster with a knife out, and you cannot shoot with it', () => {
  const { game, a, d } = pair();
  a.speed = 5; // the helper pins everyone at zero so only one agent is ever in motion
  const withRifle = paceSpeed(a);
  setWeapon(a, 'knife');
  assert.ok(paceSpeed(a) > withRifle, 'the knife is a speed bonus');
  assert.equal(paceSpeed(a) / withRifle, KNIFE.speed);

  // Held by an actual knife order, because the control loop deliberately holsters it again
  // the moment nothing is using it — an agent must never wander into a gunfight holding one.
  Object.assign(a, { reaction: 0, cooldown: 0, speed: 0 });
  Object.assign(d, { x: 40, y: 30, facing: Math.PI / 2 });
  setOrder(game, a, { type: 'knife', zone: 'Mid', point: { x: d.x, y: d.y } });
  const hp = d.hp;
  run(game, 2);
  assert.equal(a.weapon, 'knife', 'the knife stays out while the order stands');
  assert.equal(d.hp, hp, 'a drawn knife means no rifle fire, even with a target in the open');
});

test('swings have a cooldown, so a knife is not a chainsaw', () => {
  const { game, a, d } = pair();
  setWeapon(a, 'knife');
  d.facing = Math.PI / 2;
  assert.ok(slash(game, a));
  assert.equal(slash(game, a), false, 'no second swing in the same instant');
  game.time += KNIFE.interval + 0.01;
  assert.ok(slash(game, a), 'and it comes back');
});

test('an ordered knife stays out until the commander takes it back', () => {
  const { game, a } = pair();
  setOrder(game, a, { type: 'knife', zone: 'Mid', point: { x: 40, y: 34 } });
  run(game, 0.2);
  assert.equal(a.weapon, 'knife');

  // Another order does not quietly holster it. Being told to knife someone is an
  // instruction, not a suggestion the agent reconsiders as soon as it is moving again.
  setOrder(game, a, { type: 'push', zone: 'A Site', point: { x: 12, y: 14 } });
  run(game, 0.5);
  assert.equal(a.weapon, 'knife', 'it is still out');

  // Only taking it back does.
  a.knifeOrdered = false;
  run(game, 0.2);
  assert.equal(a.weapon, 'rifle', 'guns out puts it away');
});

test("a knife the agent drew itself is dropped as soon as it stops using it", () => {
  const { game, a, d } = pair();
  setOrder(game, a, { type: 'hold', zone: 'Mid', point: { x: a.x, y: a.y } });
  a.obeyUntil = 0;
  a.action = 'knife';
  run(game, 0.1);
  assert.equal(a.weapon, 'knife', 'Jev choosing to rush with it draws it');
  a.action = 'hold';
  run(game, 0.1);
  assert.equal(a.weapon, 'rifle', 'and nobody is left holding one in a gunfight');
  void d;
});

test('"move up" and "back up" resolve against where you stand, not the map', () => {
  const { game, a } = pair();
  Object.assign(a, { x: 40, y: 40, facing: -Math.PI / 2 }); // facing up the map
  const forward = relativePoint(game, a, 'forward');
  const back = relativePoint(game, a, 'back');
  assert.ok(forward.y < a.y, 'forward is the way you are looking');
  assert.ok(back.y > a.y, 'back is the other way');
  assert.ok(dist(a, forward) > 1 && dist(a, forward) <= 6.01);

  // Against a wall it gives whatever room there is rather than nothing at all.
  Object.assign(a, { x: 40, y: 30.8, facing: -Math.PI / 2 });
  const squeezed = relativePoint(game, a, 'forward');
  assert.ok(squeezed === null || dist(a, squeezed) < 6, 'a blocked step is shortened or refused');
});

test('the spike is a place you can be sent', () => {
  const { game, a } = pair();
  Object.assign(game.spike, { state: 'planted', x: 12, y: 14 });
  const at = relativePoint(game, a, 'spike');
  assert.deepEqual({ x: at.x, y: at.y }, { x: 12, y: 14 });
});

test('every zone on every map has words a person would actually say for it', () => {
  for (const map of Object.values(MAPS)) {
    for (const z of map.zones) {
      assert.ok(CALLOUTS[z.name], `${map.id}/${z.name} has no callouts`);
      assert.ok(CALLOUTS[z.name].length > 3);
    }
  }
});

test('the order vocabulary grows with the kit and never shrinks below what it was', async () => {
  const seenFor = async utility => {
    let seen = null;
    const brains = createBrains({ evaluate: async (state, questions) => { seen = questions; throw new Error('stop'); } });
    const game = createGame({ defenders: 'bots', playerTeam: 'attack', utility });
    await brains.interpretCommand(game, 'attack', { source: 'text', text: 'alpha go knife someone' }).catch(() => {});
    return seen;
  };
  const plain = Object.keys((await seenFor(false)).alpha_order.criteria);
  const kitted = Object.keys((await seenFor(true)).alpha_order.criteria);
  // The seven that were always there, plus the two that need no equipment.
  for (const base of ['push', 'hold', 'flank', 'retreat', 'regroup', 'grenade', 'plant']) {
    assert.ok(plain.includes(base), `${base} must survive`);
  }
  assert.ok(plain.includes('knife') && plain.includes('peek'));
  assert.equal(plain.includes('flash'), false, 'no flashes without the kit');
  assert.ok(kitted.includes('flash') && kitted.includes('smoke'));

  // And the places include the callouts and the spike.
  const places = Object.keys((await seenFor(false)).alpha_target.criteria);
  for (const p of ['enemy', 'current', 'spike', 'Mid', 'A Site']) {
    assert.ok(places.includes(p), `${p} must be somewhere you can be sent`);
  }
  // "Forward" and "right" only mean anything relative to what the commander is looking at,
  // so they are offered only when the client sends the angle its view calls forward.
  for (const p of ['forward', 'back', 'left', 'right']) {
    assert.equal(places.includes(p), false, `${p} needs a view to be relative to`);
  }
});

test('a view angle turns the directions on', async () => {
  let seen = null;
  const brains = createBrains({ evaluate: async (state, questions) => { seen = questions; throw new Error('stop'); } });
  const game = createGame({ defenders: 'bots', playerTeam: 'attack' });
  await brains.interpretCommand(game, 'attack', {
    source: 'text', text: 'alpha move right', direction: { yaw: 0 },
  }).catch(() => {});
  const places = Object.keys(seen.alpha_target.criteria);
  for (const p of ['forward', 'back', 'left', 'right']) {
    assert.ok(places.includes(p), `${p} should be offered once there is a view`);
  }
});

// ---------- you see what you are looking at ----------

test('nobody sees what is behind them', () => {
  const { game, a, d } = pair();
  Object.assign(a, { x: 40, y: 40, facing: -Math.PI / 2, holdBearing: -Math.PI / 2 });
  Object.assign(d, { x: 40, y: 46, facing: -Math.PI / 2, holdBearing: -Math.PI / 2 });
  stepGame(game, STEP);
  assert.equal(a.visible.length, 0, 'someone at your back is not visible');
  assert.ok(d.visible.includes(a), 'and they can see you, because you are in front of them');

  Object.assign(a, { facing: Math.PI / 2, holdBearing: Math.PI / 2 }); // turn round
  stepGame(game, STEP);
  assert.ok(a.visible.includes(d), 'turning finds them');
});

test('the cone is human-wide, so someone at your shoulder is still seen', () => {
  const { game, a, d } = pair();
  Object.assign(a, { x: 40, y: 40, facing: -Math.PI / 2, holdBearing: -Math.PI / 2 });
  // Straight out to the side: 90 degrees off, well inside peripheral vision.
  Object.assign(d, { x: 46, y: 40, facing: Math.PI });
  stepGame(game, STEP);
  assert.ok(inView(a, d), 'ninety degrees off is still seen');
  // Behind the shoulder is not.
  Object.assign(d, { x: 44, y: 45 });
  assert.equal(inView(a, d), false, 'past the shoulder is not');
});

test('being shot from behind turns you toward it, and only then can you see', () => {
  const { game, a, d } = pair();
  Object.assign(a, { x: 40, y: 40, facing: -Math.PI / 2, holdBearing: -Math.PI / 2, reaction: Infinity });
  Object.assign(d, { x: 40, y: 46, facing: -Math.PI / 2, holdBearing: -Math.PI / 2, reaction: 0, cooldown: 0, speed: 0 });
  d.seen.set(a.id, 0);
  stepGame(game, STEP);
  assert.equal(a.visible.length, 0);

  // Take a hit from behind: no order, nothing seen, but now something to turn toward.
  // Rifle fire is a coin flip per shot, so the roll is pinned — otherwise this fails for
  // nobody's reason about once in a hundred runs.
  const before = a.facing;
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    for (let f = 0; f < 60; f++) stepGame(game, STEP);
  } finally {
    Math.random = realRandom;
  }
  assert.ok(a.hp < 150, 'they are being shot');
  assert.notEqual(a.facing, before, 'and they turn toward it');
  assert.ok(a.visible.includes(d), 'having turned, they can see who it was');
});

test('a knifer coming from behind is not seen coming', () => {
  const { game, a, d } = pair();
  // The victim watches up the map; the knifer walks in from behind with a knife out.
  Object.assign(a, { x: 40, y: 40, facing: -Math.PI / 2, holdBearing: -Math.PI / 2, reaction: 0 });
  Object.assign(d, { x: 40, y: 41.6, facing: -Math.PI / 2, knifeOrdered: true });
  setWeapon(d, 'knife');
  Object.assign(d, { gaze: 'hold_angle', holdBearing: -Math.PI / 2 });
  stepGame(game, STEP);
  assert.equal(a.visible.length, 0, 'never saw them');
  assert.ok(slash(game, d), 'and the swing lands');
  assert.equal(a.alive, false, 'from behind, that is the whole fight');
});

// ---------- routes ----------

test('an order can name the way, not just the destination', () => {
  const { game, a } = pair();
  a.speed = 5;
  Object.assign(a, { x: 40, y: 50 });
  // Sent to A Site the long way round, through B Link on the other side of the map.
  setOrder(game, a, {
    type: 'push', zone: 'A Site', point: { ...zoneByName(MAPS.tactical, 'A Site').center },
    through: ['B Link'],
  });
  assert.equal(a.order.route.length, 1, 'the named node is the route');
  const via = zoneByName(MAPS.tactical, 'B Link').center;
  assert.ok(dist(a.order.route[0], via) < 0.01, 'and it is the node that was named');
  // The first place it heads for is the node, not the destination.
  const heading = orderDestination(game, a);
  assert.ok(dist(heading, via) < 0.01, 'it goes there first');
});

test('a route node is finished with once it has been reached', () => {
  const { game, a } = pair();
  const via = zoneByName(MAPS.tactical, 'Mid').center;
  setOrder(game, a, {
    type: 'push', zone: 'A Site', point: { ...zoneByName(MAPS.tactical, 'A Site').center },
    through: ['Mid'],
  });
  assert.ok(dist(orderDestination(game, a), via) < 0.01);
  Object.assign(a, { x: via.x, y: via.y });
  const next = orderDestination(game, a);
  assert.ok(dist(next, via) > 3, 'standing on it, the agent moves on to the destination');
  assert.equal(a.order.route.length, 0, 'and the node is spent');
});

test('naming the way overrides the route the map would have picked', () => {
  const { game, a } = pair();
  Object.assign(a, { x: 40, y: 50 });
  const site = { ...zoneByName(MAPS.tactical, 'A Site').center };
  setOrder(game, a, { type: 'push', zone: 'A Site', point: site });
  const automatic = a.order.route[0];
  assert.ok(automatic, 'a plain push still takes the map route into A Main');

  setOrder(game, a, { type: 'push', zone: 'A Site', point: site, through: ['B Link'] });
  const asked = zoneByName(MAPS.tactical, 'B Link').center;
  assert.equal(a.order.route.length, 1, 'one node, the one that was asked for');
  assert.ok(dist(a.order.route[0], asked) < 0.01, 'the commander outranks the map');
});
