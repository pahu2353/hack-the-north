import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import {
  KNIFE, MAX_HP, createGame, paceSpeed, relativePoint, setOrder, setWeapon,
  slash, stepGame, teamUnits,
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

test('a knife order draws the knife; anything else puts it away', () => {
  const { game, a } = pair();
  setOrder(game, a, { type: 'knife', zone: 'Mid', point: { x: 40, y: 34 } });
  run(game, 0.2);
  assert.equal(a.weapon, 'knife');
  setOrder(game, a, { type: 'hold', zone: 'Mid', point: { x: a.x, y: a.y } });
  assert.equal(a.weapon, 'rifle', 'a new order hands the rifle back');
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

  // And the places include both the callouts and the relative steps.
  const places = Object.keys((await seenFor(false)).alpha_target.criteria);
  for (const p of ['forward', 'back', 'enemy', 'current', 'Mid', 'A Site']) {
    assert.ok(places.includes(p), `${p} must be somewhere you can be sent`);
  }
});
