import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, enemyContact, obeying, setOrder, stepGame, teamUnits, throwGrenade } from '../public/commander/sim.js';
import { zoneByName } from '../public/commander/world.js';

const step = (game, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepGame(game, 1 / 60);
};
// Two squads in sight of each other in the open, with nobody shooting.
function facingOff() {
  const game = createGame({ defenders: 'players' });
  for (const u of game.units) u.reaction = Infinity;
  teamUnits(game, 'attack').forEach((u, i) => Object.assign(u, { x: 36 + i * 1.5, y: 52 }));
  teamUnits(game, 'defend').forEach((u, i) => Object.assign(u, { x: 36 + i * 1.5, y: 46 }));
  for (const u of game.units) setOrder(game, u, { type: 'hold', zone: 'Attacker Spawn', point: { x: u.x, y: u.y } });
  stepGame(game, 1 / 60);
  return game;
}

test('enemy contact falls back to the enemy spawn on each map', () => {
  for (const map of ['tactical', 'dust2']) {
    const game = createGame({ map });
    for (const team of ['attack', 'defend']) {
      const contact = enemyContact(game, team);
      const enemySpawn = zoneByName(game.map, game.map.home[team === 'attack' ? 'defend' : 'attack']);
      assert.deepEqual(contact, { ...enemySpawn.center, seenAgo: null });
    }
  }
});

test('a fresh order is carried out even with an enemy in sight', () => {
  const game = facingOff();
  const [agent] = teamUnits(game, 'attack');
  assert.ok(agent.visible.length, 'the enemy is in sight');
  agent.action = 'fight'; // what the agent had decided for itself a moment ago
  const start = { x: agent.x, y: agent.y };
  setOrder(game, agent, { type: 'push', zone: 'B Site', point: zoneByName(game.map, 'B Site').center });
  step(game, 1);
  assert.equal(agent.action, 'advance', 'the order replaces its own decision');
  assert.ok(Math.hypot(agent.x - start.x, agent.y - start.y) > 3, 'it actually set off');
});

test('an order to hold keeps an agent still while enemies are about', () => {
  const game = facingOff();
  const [agent] = teamUnits(game, 'attack');
  const start = { x: agent.x, y: agent.y };
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point: start });
  agent.action = 'support'; // a decision that would otherwise pull it away
  step(game, 2);
  assert.equal(agent.action, 'hold');
  assert.ok(Math.hypot(agent.x - start.x, agent.y - start.y) < 1, 'it stayed put');
});

test('the order stops outranking after a few seconds', () => {
  const game = facingOff();
  const [agent] = teamUnits(game, 'attack');
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point: { x: agent.x, y: agent.y } });
  assert.equal(obeying(game, agent), true);
  step(game, 3.2);
  assert.equal(obeying(game, agent), false, 'the agent decides for itself again');
});

test('a grenade about to go off still interrupts a fresh order', () => {
  const game = facingOff();
  const [agent] = teamUnits(game, 'attack');
  const [enemy] = teamUnits(game, 'defend');
  const blast = { x: agent.x, y: agent.y };
  throwGrenade(game, enemy, blast);
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point: { ...blast } });
  step(game, 0.5); // it has landed at their feet
  agent.action = 'scatter'; // what Jev decides when asked about the grenade
  step(game, 0.6);
  assert.equal(agent.action, 'scatter', 'obeying does not override getting clear');
  // Getting clear is deliberately imperfect: a grenade at your feet, with squadmates in the
  // way, often still catches you. That is what keeps clumping up dangerous.
  const away = Math.hypot(agent.x - blast.x, agent.y - blast.y);
  assert.ok(away > 0.5, `it started moving clear (${away.toFixed(1)}m)`);
});
