import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLASH, GRENADE, SMOKE, blinded, canSee, createGame, smokeBlocks,
  setOrder, stepGame, teamUnits, throwGrenade,
} from '../public/commander/sim.js';
import { dist } from '../public/commander/world.js';

const STEP = 1 / 30;
const run = (game, seconds) => {
  for (let f = 0; f < Math.round(seconds / STEP); f++) stepGame(game, STEP);
};

// Two agents in open ground in Mid, facing each other, nobody else able to interfere.
function duel({ utility = true } = {}) {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', utility });
  const a = teamUnits(game, 'attack')[0];
  const d = teamUnits(game, 'defend')[0];
  for (const u of game.units) { u.reaction = Infinity; u.speed = 0; u.obeyUntil = Infinity; }
  // Everyone else is parked in a corner so only these two are ever in each other's way.
  for (const u of game.units) if (u !== a && u !== d) Object.assign(u, { x: 2, y: 2 });
  Object.assign(a, { x: 40, y: 40, facing: -Math.PI / 2 });
  Object.assign(d, { x: 40, y: 34, facing: Math.PI / 2 });
  return { game, a, d };
}

test('by default nobody carries anything but a grenade, so a normal match is unchanged', () => {
  const game = createGame({ defenders: 'players' });
  assert.equal(game.utility, false);
  for (const u of game.units) {
    assert.equal(u.grenades, GRENADE.carried);
    assert.equal(u.flashes, 0);
    assert.equal(u.smokes, 0);
  }
  // And nothing can be thrown that was not in the loadout.
  assert.equal(throwGrenade(game, teamUnits(game, 'attack')[0], { x: 40, y: 45 }, 'flash'), false);
});

test('turning the kit on hands everyone one of each', () => {
  const game = createGame({ defenders: 'players', utility: true });
  for (const u of game.units) {
    assert.equal(u.grenades, GRENADE.carried);
    assert.equal(u.flashes, FLASH.carried);
    assert.equal(u.smokes, SMOKE.carried);
  }
});

test('a smoke blocks the view both ways without blocking anything else', () => {
  const { game, a, d } = duel();
  run(game, 0.1);
  assert.ok(a.visible.includes(d), 'they should see each other to begin with');

  assert.ok(throwGrenade(game, a, { x: 40, y: 37 }, 'smoke'), 'the smoke should be throwable');
  run(game, 2);
  assert.equal(game.smokes.length, 1);
  assert.ok(smokeBlocks(game, a, d), 'the cloud sits on the sightline');
  assert.equal(canSee(game, a, d), false);
  assert.equal(canSee(game, d, a), false, 'a smoke is not one-way');
  assert.equal(a.visible.length, 0, 'nothing to shoot at through it');
  assert.equal(d.visible.length, 0);

  // It is only vision. A grenade thrown into the same place still hurts.
  const hp = d.hp;
  assert.ok(throwGrenade(game, a, { x: 40, y: 34 }, 'frag'));
  run(game, 3);
  assert.ok(d.hp < hp, 'smoke must not stop a grenade');
});

test('a smoke thins out and stops blocking on its own', () => {
  const { game, a, d } = duel();
  throwGrenade(game, a, { x: 40, y: 37 }, 'smoke');
  run(game, 2);
  assert.equal(canSee(game, a, d), false);
  run(game, SMOKE.lifetime + 1);
  assert.equal(game.smokes.length, 0, 'the cloud should be gone');
  assert.ok(canSee(game, a, d), 'and the angle should be open again');
});

test('a flash blinds whoever can see it, and a wall is a complete defence', () => {
  const { game, a, d } = duel();
  // Behind the block between Mid and B Main (x 48-66, y 21-44): no line to the pop at all.
  const sheltered = teamUnits(game, 'defend')[1];
  Object.assign(sheltered, { x: 70, y: 32, facing: Math.PI });

  assert.ok(throwGrenade(game, a, { x: 40, y: 36 }, 'flash'));
  run(game, 1.6);
  assert.ok(blinded(game, d), 'someone looking straight at the pop is blinded');
  assert.equal(blinded(game, sheltered), false, 'a wall between you and it means nothing at all');
  assert.equal(d.visible.length, 0, 'a blinded agent has no targets');
});

test('a flash cannot reach through a smoke either', () => {
  const { game, a, d } = duel();
  throwGrenade(game, a, { x: 40, y: 37 }, 'smoke');
  run(game, 2);
  a.throwReadyAt = 0;
  assert.ok(throwGrenade(game, a, { x: 40, y: 38 }, 'flash'));
  run(game, 1.6);
  assert.equal(blinded(game, d), false, 'you cannot be blinded by a light you cannot see');
});

test('looking away from a flash is most of the defence', () => {
  const facing = angle => {
    const { game, a, d } = duel();
    // Pin the angle: the agent is holding it deliberately, so nothing re-aims it before the
    // pop. Without this the occupy loop turns them toward the threat and both cases match.
    setOrder(game, d, { type: 'hold', zone: 'Mid', point: { x: d.x, y: d.y } });
    Object.assign(d, { facing: angle, gaze: 'hold_angle', holdBearing: angle, occupying: true, obeyUntil: Infinity });
    throwGrenade(game, a, { x: 40, y: 36 }, 'flash');
    run(game, 1.6);
    return Math.max(0, d.blindUntil - game.time);
  };
  const at = facing(Math.PI / 2); // staring at it
  const away = facing(-Math.PI / 2); // back turned
  assert.ok(at > away * 2, `facing it should cost far more: ${at.toFixed(2)}s vs ${away.toFixed(2)}s`);
});

test('a blinded agent cannot shoot, and recovers when it wears off', () => {
  const { game, a, d } = duel();
  Object.assign(a, { reaction: 0, cooldown: 0 });
  const enemy = teamUnits(game, 'defend')[0];
  run(game, 0.2);
  a.blindUntil = game.time + 1.5;
  const hp = enemy.hp;
  run(game, 1.4);
  assert.equal(enemy.hp, hp, 'no vision means no automatic fire');
  run(game, 1.5);
  assert.ok(enemy.hp < hp, 'and it comes back');
  assert.equal(blinded(game, a), false);
  void d;
});

test('only a frag is worth diving away from', async () => {
  const { incomingGrenade } = await import('../public/commander/sim.js');
  const { game, a, d } = duel();
  throwGrenade(game, a, { x: 40, y: 34 }, 'smoke');
  run(game, 0.4);
  assert.equal(incomingGrenade(game, d), null, 'nobody scatters from a smoke');
  a.throwReadyAt = 0;
  throwGrenade(game, a, { x: 40, y: 34 }, 'frag');
  run(game, 0.4);
  assert.ok(incomingGrenade(game, d), 'a frag is still a reason to move');
});

test('the whole kit survives a full round on both maps', () => {
  for (const map of ['tactical', 'dust2']) {
    const game = createGame({ defenders: 'bots', playerTeam: 'attack', map, utility: true });
    const squad = teamUnits(game, 'attack');
    for (let i = 0; i < 5; i++) {
      const u = squad[i];
      u.throwReadyAt = 0;
      throwGrenade(game, u, { x: u.x, y: u.y + (u.team === 'attack' ? -6 : 6) }, ['frag', 'flash', 'smoke'][i % 3]);
    }
    assert.doesNotThrow(() => run(game, 30), `${map} should survive a round with the full kit`);
    assert.ok(dist(squad[0], squad[0]) === 0);
  }
});
