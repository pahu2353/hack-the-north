import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import {
  CALLOUT_SECONDS, FORMATION, createGame, enemyContact, noteCallout, paceSpeed,
  rifleAccuracy, setOrder, stepGame, teamUnits,
} from '../public/commander/sim.js';
import { MAPS, angleDiff, dist, zoneByName } from '../public/commander/world.js';

const STEP = 1 / 30;

// One agent under test, nobody shooting, nobody else moving: whatever the agent does is the
// thing being measured and not a side effect of four teammates shoving it.
function alone({ map = 'tactical' } = {}) {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', map });
  const agent = teamUnits(game, 'attack')[0];
  for (const u of game.units) {
    u.reaction = Infinity;
    if (u !== agent) { u.speed = 0; u.obeyUntil = Infinity; }
  }
  return { game, agent };
}

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


test('an order is looked at before it is walked, so it visibly lands', () => {
  const { game, agent } = alone();
  // Facing the wrong way entirely, and standing still: nothing used to move the angle at all
  // until the feet did, so an order had no visible effect for as long as pathing took.
  Object.assign(agent, { x: 40, y: 50, facing: Math.PI / 2 });
  const site = zoneByName(MAPS.tactical, 'A Site');
  setOrder(game, agent, { type: 'push', zone: 'A Site', point: { ...site.center } });
  const before = agent.facing;
  run(game, 0.2);
  const toward = Math.atan2(site.center.y - agent.y, site.center.x - agent.x);
  assert.ok(angleDiff(agent.facing, toward) < angleDiff(before, toward),
    'the agent should have turned toward where it was sent');
});

test('an agent that has arrived holds an angle instead of staring where it walked from', () => {
  const { game, agent } = alone();
  const post = { x: 12, y: 30 };
  Object.assign(agent, { x: post.x, y: post.y, obeyUntil: 0 });
  setOrder(game, agent, { type: 'hold', zone: 'A Main', point: post });
  run(game, 4);
  assert.equal(agent.moving, false, 'it should have arrived');
  assert.ok(agent.occupying, 'an agent standing on its post is occupying it');
  assert.ok(agent.holdBearing !== null, 'it should have picked an angle to hold');
  // The angle it holds is the way the enemy is known or expected to come, not the way it
  // happened to be pointing.
  const threat = enemyContact(game, 'attack');
  const toThreat = Math.atan2(threat.y - agent.y, threat.x - agent.x);
  assert.ok(angleDiff(agent.holdBearing, toThreat) < 0.01, 'the held angle should face the threat');
  assert.ok(['scan', 'hold_angle'].includes(agent.gaze), `gaze should be a holding one, was ${agent.gaze}`);
});

test('a held angle is swept rather than frozen, and the sweep stays around the angle', () => {
  const { game, agent } = alone();
  Object.assign(agent, { x: 12, y: 30, obeyUntil: 0 });
  setOrder(game, agent, { type: 'hold', zone: 'A Main', point: { x: 12, y: 30 } });
  run(game, 3);
  const seen = new Set();
  let worst = 0;
  for (let f = 0; f < 200; f++) {
    stepGame(game, STEP);
    seen.add(Math.round(agent.facing * 20));
    worst = Math.max(worst, angleDiff(agent.facing, agent.holdBearing));
  }
  assert.ok(seen.size > 8, `a scanning agent should move its aim, saw ${seen.size} angles`);
  assert.ok(worst < 1.2, `the sweep should stay around the held angle, drifted ${worst} rad`);
});

test('pace is a real speed, and walking keeps the aim that running spoils', () => {
  const { game, agent } = alone();
  assert.equal(paceSpeed({ ...agent, pace: 'run' }), agent.speed);
  assert.ok(paceSpeed({ ...agent, pace: 'walk' }) < agent.speed * 0.6);
  assert.equal(paceSpeed({ ...agent, pace: 'still' }), 0);

  // Same shot, same distance, only the pace differs.
  const target = teamUnits(game, 'defend')[0];
  Object.assign(agent, { x: 40, y: 40, moving: true });
  Object.assign(target, { x: 40, y: 30, moving: false });
  const accuracy = pace => {
    agent.pace = pace;
    return rifleAccuracy(game, agent, target);
  };
  assert.ok(accuracy('walk') > accuracy('run') * 1.8, 'walking should be far more accurate than running');
});

test('an order given with no urgency spreads the squad; an urgent one stacks it', () => {
  const site = zoneByName(MAPS.tactical, 'B Site');
  // Mean spacing, not the closest pair: posts are snapped to walkable ground, and around
  // B site's cover that snapping can push two slots together whatever the formation asked for.
  const spacing = spread => {
    const game = createGame({ defenders: 'players', playerTeam: 'attack' });
    const squad = teamUnits(game, 'attack');
    for (const u of squad) setOrder(game, u, { type: 'push', zone: 'B Site', point: { ...site.center }, spread });
    const gaps = squad.flatMap((a, i) => squad.slice(i + 1).map(b => dist(a.order.point, b.order.point)));
    return gaps.reduce((sum, d) => sum + d, 0) / gaps.length;
  };
  assert.ok(spacing('spread') > spacing('normal'), 'a calm order should stand the squad further apart');
  assert.ok(spacing('stacked') < spacing('normal'), 'an urgent order should stack them up');
  assert.ok(FORMATION.spread > FORMATION.normal && FORMATION.stacked < FORMATION.normal);
});

test('holding fire keeps a lurker hidden, but never gets them killed for it', () => {
  const { game, agent } = alone();
  const enemy = teamUnits(game, 'defend')[0];
  // Both in Mid with nothing between them, and far enough apart that the point-blank
  // exemption does not apply.
  Object.assign(agent, { x: 40, y: 40, reaction: 0, holdFire: true, cooldown: 0 });
  Object.assign(enemy, { x: 40, y: 32, reaction: Infinity, speed: 0 });
  const hp = enemy.hp;
  run(game, 2);
  assert.equal(enemy.hp, hp, 'a lurker holding fire should not give itself away');

  // Being shot at is not a moment to stay polite. The enemy keeps firing, so the exemption
  // stays true rather than lapsing a second after one shot.
  everyShotHits(() => {
    for (let f = 0; f < 60; f++) {
      Object.assign(enemy, { targetId: agent.id, lastShotAt: game.time });
      stepGame(game, STEP);
    }
  });
  assert.ok(enemy.hp < hp, 'an agent under fire defends itself even while holding fire');
});

test('a callout steers where the squad watches, and expires', () => {
  const { game } = alone();
  const b = zoneByName(MAPS.tactical, 'B Site').center;
  assert.equal(enemyContact(game, 'attack').seenAgo, null, 'nothing seen yet');
  noteCallout(game, 'attack', b);
  const after = enemyContact(game, 'attack');
  assert.ok(dist(after, b) < 0.01, 'the squad should now expect the enemy where it was called');
  game.time += CALLOUT_SECONDS + 1;
  assert.equal(enemyContact(game, 'attack').seenAgo, null, 'a stale callout stops steering anyone');
});

test('enemyContact works on every map, not just the one whose spawns are named by default', () => {
  for (const map of Object.keys(MAPS)) {
    const game = createGame({ defenders: 'players', map });
    for (const team of ['attack', 'defend']) {
      const at = enemyContact(game, team);
      assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y), `${map}/${team} should have a fallback`);
    }
  }
});

test('two agents sent to one place are given different jobs', async () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack' });
  const squad = teamUnits(game, 'attack');
  for (const u of game.units) u.reaction = Infinity;
  const brains = createBrains({
    evaluate: async (state, questions) => ({
      answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
        if (q.type === 'boolean') return [id, { probability: id === 'is_order' ? 1 : 0 }];
        const keys = Object.keys(q.criteria);
        const pick = id.endsWith('_order') ? 'push' : id.endsWith('_target') ? 'B Site' : keys[0];
        return [id, { choice: keys.includes(pick) ? pick : keys[0], probabilities: { [pick]: 1 } }];
      })),
      latency: 1,
    }),
  });
  await brains.interpretCommand(game, 'attack', { source: 'text', text: 'everyone push B' });
  const roles = squad.map(u => u.role);
  assert.ok(roles.includes('entry'), `someone has to go in first, got ${roles}`);
  assert.ok(roles.includes('trade'), `someone has to cover them, got ${roles}`);
  const trade = squad.find(u => u.role === 'trade');
  assert.equal(trade.pace, 'walk', 'the trade walks in behind rather than racing the entry');
  const entry = squad.find(u => u.role === 'entry');
  assert.ok(dist(entry, entry.order.point) <= dist(trade, trade.order.point) + 1e-9,
    'the one closest to the objective is the one who goes in');
});
