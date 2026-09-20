import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedAt, dist } from '../public/commander/world.js';
import { createGame, setOrder, stepGame } from '../public/commander/sim.js';

const STEP = 1 / 30;

// An agent sent straight through a wall: the destination is unreachable in a straight line, so
// it has to go around. What it must never do is walk in, get shoved out and try again.
//
// Everyone else stays alive — a wiped squad ends the round before the agent takes a step — but
// is pinned and silent, so the only thing acting on the agent under test is the map.
function walled() {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', prep: false });
  const agent = game.units.find(u => u.team === 'attack');
  for (const u of game.units) {
    u.reaction = Infinity; // nobody shoots, so nothing turns to aim
    if (u === agent) continue;
    u.speed = 0; // pinned where they spawned, far from the corridors under test
    u.obeyUntil = Infinity;
  }
  return { game, agent };
}

test('an agent walked straight into a wall slides along it instead of vibrating in place', () => {
  const { game, agent } = walled();
  // The block between Mid and B Main spans x 48-66, y 21-44. Stand underneath it and pin a
  // waypoint on the far side, so the only way through the wall is into it. Pathfinding would
  // normally route around and never test this; here the agent has to meet the wall head-on.
  Object.assign(agent, { x: 52, y: 46, obeyUntil: Infinity });
  setOrder(game, agent, { type: 'push', zone: 'B Site', point: { x: 52, y: 18 } });

  let reversals = 0;
  let insideWall = 0;
  let last = null;
  for (let f = 0; f < 120; f++) {
    // Re-pin every frame: the point is to hold the agent against the wall, not to watch it
    // find its way around one.
    agent.path = [{ x: 52, y: 18 }];
    agent.pathGoal = { x: 52, y: 18 };
    agent.repathAt = Infinity;
    const from = { x: agent.x, y: agent.y };
    stepGame(game, STEP);
    const d = { x: agent.x - from.x, y: agent.y - from.y };
    if (blockedAt(game.map, agent.x, agent.y, agent.r - 1e-6)) insideWall++;
    if (last && Math.hypot(d.x, d.y) > 1e-4 && last.x * d.x + last.y * d.y < 0) reversals++;
    last = d;
  }

  assert.equal(insideWall, 0, 'the agent should never end a frame inside a wall');
  assert.equal(reversals, 0, 'the agent should never reverse direction against a wall');
  // It stops at the wall rather than passing through it.
  assert.ok(agent.y >= 44 + agent.r - 1e-6, `the agent should be held outside the wall, at y=${agent.y}`);
});

test('a walking agent turns at a bounded rate, so a shove cannot spin it', () => {
  const { game, agent } = walled();
  Object.assign(agent, { x: 40, y: 40, facing: 0, obeyUntil: Infinity, lastShotAt: -Infinity });
  setOrder(game, agent, { type: 'push', zone: 'A Site', point: { x: 12, y: 14 } });

  let worst = 0;
  for (let f = 0; f < 200; f++) {
    const before = agent.facing;
    stepGame(game, STEP);
    const turn = Math.abs(Math.atan2(Math.sin(agent.facing - before), Math.cos(agent.facing - before)));
    worst = Math.max(worst, turn);
  }
  // 10 rad/s is the cap; allow the frame's worth of it plus rounding.
  assert.ok(worst <= 10 * STEP + 1e-6, `worst single-frame turn was ${worst} rad`);
});

test('an agent held up against geometry asks for a new path rather than grinding', () => {
  const { game, agent } = walled();
  // Pinned against the wall with the destination straight through it and no teammate nearby,
  // so the stall has to be read as a bad route.
  Object.assign(agent, { x: 52, y: 46, obeyUntil: Infinity });
  setOrder(game, agent, { type: 'push', zone: 'B Site', point: { x: 52, y: 18 } });
  let repathsAsked = 0;
  for (let f = 0; f < 60; f++) {
    agent.path = [{ x: 52, y: 18 }];
    agent.pathGoal = { x: 52, y: 18 };
    agent.repathAt = Infinity;
    stepGame(game, STEP);
    if (agent.repathAt <= game.time) repathsAsked++; // noteProgress asked for a new route
  }
  // The stall is noticed and answered with a repath, not by parking against the wall.
  assert.equal(agent.settledAt, null, 'a wall is not a reason to give up on the destination');
  assert.ok(repathsAsked > 0, 'a stalled agent should be asked to find another way round');
});

// The squad is routinely sent to one point — "everyone push B" — and near a wall the per-agent
// slot offsets can collapse onto each other. Whoever arrives last used to shove the others off
// the spot and walk back in, for the rest of the round.
test('a squad crowded onto one spot settles instead of shoving each other forever', () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', prep: false });
  const squad = game.units.filter(u => u.team === 'attack');
  for (const u of game.units) u.reaction = Infinity;
  for (const u of game.units.filter(o => o.team === 'defend')) u.speed = 0;
  const point = { x: 3, y: 8 }; // the corner of A site, walls on two sides
  squad.forEach((u, i) => {
    Object.assign(u, { x: 10 + i * 0.5, y: 34, obeyUntil: Infinity });
    setOrder(game, u, { type: 'push', zone: 'A Site', point });
  });

  let reversals = 0;
  const last = new Map();
  for (let f = 0; f < 600; f++) {
    const before = new Map(squad.map(u => [u.id, { x: u.x, y: u.y }]));
    stepGame(game, STEP);
    for (const u of squad) {
      const b = before.get(u.id);
      const d = { x: u.x - b.x, y: u.y - b.y };
      const prev = last.get(u.id);
      if (prev && Math.hypot(d.x, d.y) > 1e-4 && prev.x * d.x + prev.y * d.y < 0) reversals++;
      last.set(u.id, d);
    }
  }

  // Shoving each other used to reverse someone on about 40% of frames.
  assert.ok(reversals < 150, `squad reversed direction on ${reversals} of 3000 unit-frames`);
  // They still all got where they were sent.
  for (const u of squad) {
    assert.ok(dist(u, point) < 6, `${u.name} ended ${dist(u, point).toFixed(1)}m from the order point`);
  }
});

// Settling is only a truce with the teammates standing on the spot. If it outlived them, a
// defuser could park 1.2 m from the spike — outside the 1.5 m it has to be within — and never
// start defusing.
test('an agent that settled for a crowd takes the spot once the crowd is gone', () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack', prep: false });
  const squad = game.units.filter(u => u.team === 'attack');
  for (const u of game.units) u.reaction = Infinity;
  for (const u of game.units.filter(o => o.team === 'defend')) u.speed = 0;
  const point = { x: 3, y: 8 };
  squad.forEach((u, i) => {
    Object.assign(u, { x: 4 + i * 0.4, y: 10, obeyUntil: Infinity });
    setOrder(game, u, { type: 'push', zone: 'A Site', point });
  });
  for (let f = 0; f < 200; f++) stepGame(game, STEP);

  const settled = squad.filter(u => u.settledAt);
  assert.ok(settled.length > 0, 'someone should have settled for the crowd');

  // Clear everyone but one settled agent, and let it get on with it.
  const survivor = settled[0];
  for (const u of squad) if (u !== survivor) u.alive = false;
  const before = dist(survivor, point);
  for (let f = 0; f < 200; f++) stepGame(game, STEP);

  assert.equal(survivor.settledAt, null, 'the truce should end with the crowd');
  assert.ok(dist(survivor, point) < before, 'it should close on the spot it was sent to');
  assert.ok(dist(survivor, point) < 1.5, `ended ${dist(survivor, point).toFixed(2)}m away, outside defuse range`);
});
