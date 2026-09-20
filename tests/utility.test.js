import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import {
  FLASH, GRENADE, SMOKE, UTILITY, blinded, canSee, createGame, flashExposure, glareOf,
  smokeBlocks, setOrder, stepGame, teamUnits, throwGrenade, throwLanding, utilitySpot,
} from '../public/commander/sim.js';
import { MAPS, dist } from '../public/commander/world.js';

const STEP = 1 / 30;
const run = (game, seconds) => {
  for (let f = 0; f < Math.round(seconds / STEP); f++) stepGame(game, STEP);
};

// Rifle fire is a coin flip per shot, so "did anyone get hit" is only ever probably true.
// A test about whether shooting happened at all pins the roll instead, or it fails for
// nobody's reason a few runs in a hundred.
function everyShotHits(body) {
  const real = Math.random;
  Math.random = () => 0;
  try { return body(); } finally { Math.random = real; }
}


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
  everyShotHits(() => run(game, 1.4));
  assert.equal(enemy.hp, hp, 'no vision means no automatic fire');
  everyShotHits(() => run(game, 1.5));
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

// ---------- throwing: reach, arcs, and who actually throws ----------

test('a throw has a reach, and it is nowhere near the size of the map', () => {
  const { game, a } = duel();
  for (const kind of ['frag', 'flash', 'smoke']) {
    a.throwReadyAt = 0;
    const far = { x: a.x, y: a.y - (UTILITY[kind].range + 6) };
    assert.equal(throwGrenade(game, a, far, kind), false, `${kind} cannot cross the map`);
  }
  // Well inside reach, it goes.
  a.throwReadyAt = 0;
  assert.ok(throwGrenade(game, a, { x: a.x, y: a.y - 8 }, 'smoke'));
});

test('a lob clears low cover and comes up short against a building', () => {
  const map = MAPS.tactical;
  // Lobby cover is 4×2 — small enough on both axes to be waist-high cover, which is the
  // thing a lob is supposed to clear.
  const overCover = throwLanding(map, { x: 22, y: 52 }, { x: 22, y: 46 });
  assert.equal(overCover.blocked, false, 'a waist-high block is something you throw over');
  assert.ok(dist(overCover, { x: 22, y: 46 }) < 0.01);

  // A full-height interior wall is not, even though it is only two metres deep.
  const intoMidBlock = throwLanding(map, { x: 40, y: 34 }, { x: 40, y: 25 });
  assert.ok(intoMidBlock.blocked, 'a head-height wall stops a lob');

  // The mass between Mid and B Main is interior architecture, and taller than a lob.
  const intoWall = throwLanding(map, { x: 46, y: 32 }, { x: 68, y: 32 });
  assert.ok(intoWall.blocked, 'you cannot lob through a building');
  assert.ok(dist(intoWall, { x: 68, y: 32 }) > 5, 'it lands short, on your side of it');
});

test('a throw no longer needs line of sight, but a fumble at your own feet is refused', () => {
  const { game, a } = duel();
  // Straight into the side of the block it is standing against: nowhere for it to go.
  Object.assign(a, { x: 47, y: 32 });
  a.throwReadyAt = 0;
  assert.equal(throwGrenade(game, a, { x: 60, y: 32 }, 'smoke'), false, 'not into a wall at arm\'s length');
  assert.equal(a.smokes, SMOKE.carried, 'and it is not spent on the attempt');
});

test('a flash goes off on its own timer, so it can pop past a corner', () => {
  const { game, a } = duel();
  assert.ok(throwGrenade(game, a, { x: a.x, y: a.y - 20 }, 'flash'));
  const shell = game.grenades.at(-1);
  assert.ok(shell.explodeAt > 0, 'a flash is armed the moment it leaves the hand');
  assert.ok(shell.explodeAt < shell.landAt + 0.01 || FLASH.fuse < 2, 'it does not wait to land');
  run(game, 0.5);
  assert.ok(shell.z > 0.5, 'and it is still in the air on the way');
});

test('a squad told to smoke one place spends one smoke, not five', async () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', utility: true });
  const squad = teamUnits(game, 'attack');
  for (const u of game.units) u.reaction = Infinity;
  const brains = createBrains({
    evaluate: async (state, questions) => ({
      answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
        if (q.type === 'boolean') return [id, { probability: id === 'is_order' ? 1 : 0 }];
        const keys = Object.keys(q.criteria);
        const want = id.endsWith('_order') ? 'smoke' : id.endsWith('_target') ? 'Mid' : keys[0];
        return [id, { choice: keys.includes(want) ? want : keys[0], probabilities: { [want]: 1 } }];
      })),
      latency: 1,
    }),
  });
  await brains.interpretCommand(game, 'attack', { source: 'text', text: 'everyone smoke mid' });
  const throwing = squad.filter(u => u.order.type === 'smoke');
  assert.equal(throwing.length, 1, `exactly one agent throws it, got ${throwing.length}`);
  // And the rest are still doing something, not standing idle with a cancelled order.
  for (const u of squad) assert.ok(u.order, `${u.name} still has a job`);
});

test('the kit comes back each round and never stacks up', () => {
  const first = createGame({ defenders: 'players', utility: true });
  const u = teamUnits(first, 'attack')[0];
  u.throwReadyAt = 0;
  throwGrenade(first, u, { x: u.x, y: u.y - 6 }, 'smoke');
  assert.equal(u.smokes, 0, 'spent');
  // A round is a fresh game with the same match, which is how the real loop does it.
  const next = createGame({ defenders: 'players', utility: true, match: first.match });
  for (const fresh of teamUnits(next, 'attack')) {
    assert.equal(fresh.smokes, SMOKE.carried);
    assert.equal(fresh.flashes, FLASH.carried);
    assert.equal(fresh.grenades, GRENADE.carried);
  }
});

// ---------- how many throw, and what happens when nobody can ----------

// Drives a real interpretCommand with a stubbed Jev that answers a smoke order for everyone
// and whatever headcount the test asks for. Levels are scored from zero, so one agent is 0.
async function smokeOrder({ headcount = 0, stock = 1 } = {}) {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', utility: true });
  const squad = teamUnits(game, 'attack');
  for (const u of game.units) u.reaction = Infinity;
  for (const u of squad) u.smokes = stock;
  const brains = createBrains({
    evaluate: async (state, questions) => ({
      answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
        // Every agent is addressed and it is a real order; everything else answers no.
        if (q.type === 'boolean') return [id, { probability: id === 'is_order' || id.endsWith('_addressed') ? 1 : 0 }];
        if (q.type === 'score') return [id, { score: headcount }];
        const keys = Object.keys(q.criteria);
        const want = id.endsWith('_order') ? 'smoke' : id.endsWith('_target') ? 'Mid' : keys[0];
        return [id, { choice: keys.includes(want) ? want : keys[0], probabilities: { [want]: 1 } }];
      })),
      latency: 1,
    }),
  });
  const res = await brains.interpretCommand(game, 'attack', { source: 'text', text: 'smoke mid' });
  return { game, squad, res, throwing: squad.filter(u => u.order.type === 'smoke') };
}

test('a bare throw order is one agent, and an explicit "everyone" is all of them', async () => {
  assert.equal((await smokeOrder({ headcount: 0 })).throwing.length, 1, 'the default is one');
  assert.equal((await smokeOrder({ headcount: 2 })).throwing.length, 3, 'three means three');
  assert.equal((await smokeOrder({ headcount: 4 })).throwing.length, 5, 'everyone means everyone');
});

test('the ones who are not throwing are given back a job, not left with nothing', async () => {
  const { squad, res } = await smokeOrder({ headcount: 0 });
  for (const u of squad) assert.ok(u.order, `${u.name} still has an order`);
  const stood = res.plan.filter(p => p.standDown);
  assert.equal(stood.length, 4);
  for (const p of stood) assert.equal(p.standDown, 'someone else has it');
});

test('an order to throw what nobody is carrying fails, and says so', async () => {
  const { game, squad, res } = await smokeOrder({ headcount: 0, stock: 0 });
  assert.equal(squad.filter(u => u.order.type === 'smoke').length, 0, 'nobody is left holding the order');
  assert.ok(res.plan.every(p => p.standDown === 'no smoke left'));
  assert.ok(game.feed.some(f => /No smokes left/.test(f.text)), 'and the commander is told');
});

test('whoever actually has one is the one who throws it', async () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', utility: true });
  const squad = teamUnits(game, 'attack');
  for (const u of game.units) u.reaction = Infinity;
  // Only the agent standing furthest away still has a smoke.
  const holder = squad[4];
  for (const u of squad) u.smokes = u === holder ? 1 : 0;
  const brains = createBrains({
    evaluate: async (state, questions) => ({
      answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
        if (q.type === 'boolean') return [id, { probability: id === 'is_order' || id.endsWith('_addressed') ? 1 : 0 }];
        if (q.type === 'score') return [id, { score: 0 }];
        const keys = Object.keys(q.criteria);
        const want = id.endsWith('_order') ? 'smoke' : id.endsWith('_target') ? 'Attacker Spawn' : keys[0];
        return [id, { choice: keys.includes(want) ? want : keys[0], probabilities: { [want]: 1 } }];
      })),
      latency: 1,
    }),
  });
  await brains.interpretCommand(game, 'attack', { source: 'text', text: 'smoke spawn' });
  const throwing = squad.filter(u => u.order.type === 'smoke');
  assert.deepEqual(throwing.map(u => u.name), [holder.name], 'an empty agent is never picked');
});

// ---------- where a flash and a smoke actually want to go ----------

test('a flash is aimed where it blinds them and not your own squad', () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', utility: true });
  const squad = teamUnits(game, 'attack');
  const foes = teamUnits(game, 'defend');
  for (const u of game.units) u.reaction = Infinity;
  // Both lines down the east side of Mid, clear of the cover block at x 37-43, so they can
  // actually see each other — a flash is aimed at a threat, and an unseen one is not a threat.
  squad.forEach((u, i) => Object.assign(u, { x: 45 + i * 0.6, y: 42, facing: -Math.PI / 2 }));
  foes.forEach((u, i) => Object.assign(u, { x: 45 + i * 0.6, y: 26, facing: Math.PI / 2 }));
  for (let f = 0; f < 4; f++) stepGame(game, 1 / 60);

  const spot = utilitySpot(game, squad[0], 'flash');
  assert.ok(spot, 'there should be somewhere worth flashing');
  const onThem = foes.reduce((n, e) => n + flashExposure(game, spot, e), 0);
  const onUs = squad.reduce((n, m) => n + flashExposure(game, spot, m), 0);
  assert.ok(onThem > 0, 'it has to reach at least one of them');
  assert.ok(onThem > onUs, `it should catch them harder than us: ${onThem.toFixed(2)} vs ${onUs.toFixed(2)}`);
});

test('a flash with nothing to gain is not thrown at all', () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', utility: true });
  const a = teamUnits(game, 'attack')[0];
  for (const u of game.units) u.reaction = Infinity;
  // Nobody seen, no intel: there is nothing to aim at.
  assert.equal(utilitySpot(game, a, 'flash'), null);
});

test('a smoke goes on the way in, not flat against the far wall', () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', utility: true });
  const a = teamUnits(game, 'attack')[0];
  const e = teamUnits(game, 'defend')[0];
  for (const u of game.units) u.reaction = Infinity;
  // Down A Main toward A Site: the choke at the top of the corridor is the thing to cut.
  Object.assign(a, { x: 10, y: 34 });
  Object.assign(e, { x: 10, y: 22 });
  for (let f = 0; f < 4; f++) stepGame(game, 1 / 60);

  const spot = utilitySpot(game, a, 'smoke');
  assert.ok(spot, 'a corridor is exactly what a smoke is for');
  // Between the two of them, and clear of both.
  assert.ok(dist(a, spot) >= SMOKE.radius * 0.8, 'not dropped at your own feet');
  assert.ok(dist(e, spot) >= SMOKE.radius * 0.8, 'nor in their lap');
  assert.ok(dist(a, spot) < dist(a, e) + 1, 'and not thrown past them');
});

test('a flash lights the screen of everyone who sees it, blind or not', () => {
  const { game, a, d } = duel();
  // Thrown behind the thrower, so it goes off 13 m from the defender — inside the reach of
  // a flash, but at the very edge of it, and on a clear line.
  assert.ok(throwGrenade(game, a, { x: 40, y: 47 }, 'flash'));
  run(game, 1.4);
  assert.equal(blinded(game, d), false, 'at the edge of it, their sight survives');
  assert.ok(glareOf(game, d) > 0, 'but they still saw it go off');
  run(game, 1.2);
  assert.equal(glareOf(game, d), 0, 'and it clears on its own');
});
