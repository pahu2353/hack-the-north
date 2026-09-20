import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import { createGame, setOrder, stepGame, teamUnits, throwGrenade } from '../public/commander/sim.js';

function fixture() {
  const game = createGame({ defenders: 'players' });
  const [agent] = teamUnits(game, 'attack');
  const [enemy] = teamUnits(game, 'defend');
  for (const u of game.units) {
    u.reaction = Infinity;
    u.brain = { pending: false, nextAt: Infinity };
  }
  Object.assign(agent, { x: 36, y: 52, obeyUntil: 0, visible: [enemy], action: 'advance' });
  Object.assign(enemy, { x: 36, y: 46 });
  agent.brain.nextAt = 0;
  const requests = [];
  const brains = createBrains({ evaluate: (state, questions) => new Promise(resolve => requests.push({ state, questions, resolve })) });
  const reply = async (index, action) => {
    requests[index].resolve({ answers: { action: { choice: action } }, latency: 1 });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { game, agent, enemy, brains, requests, reply };
}

test('a tactical reply for an old order cannot replace a newer command, even after its priority window', async () => {
  const { game, agent, brains, requests, reply } = fixture();
  brains.update(game, 'attack');
  assert.equal(requests.length, 1);
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point: { x: agent.x, y: agent.y } });
  agent.action = 'hold';
  game.time += 4;
  await reply(0, 'support');
  assert.equal(agent.action, 'hold');
  assert.equal(agent.order.type, 'hold');
  assert.equal(agent.brain.pending, false);
  agent.brain.nextAt = 0;
  brains.update(game, 'attack');
  assert.equal(requests[1].state.commander_order, 'hold → Attacker Spawn');
  await reply(1, 'hold');
});

test('a grenade is considered even with no enemies or teammates in contact', async () => {
  const { game, agent, enemy, brains, requests, reply } = fixture();
  const point = { x: agent.x, y: agent.y };
  assert.equal(throwGrenade(game, enemy, point), true);
  for (let t = 0; t < 0.5; t += 1 / 60) stepGame(game, 1 / 60);
  for (const u of game.units) u.visible = [];
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point });
  brains.update(game, 'attack');
  assert.equal(requests.length, 1);
  assert(requests[0].state.grenade_about_to_go_off);
  assert(requests[0].questions.action.criteria.scatter);
  await reply(0, 'scatter');
  const order = agent.order;
  for (let t = 0; t < 0.25; t += 1 / 60) stepGame(game, 1 / 60);
  assert.equal(agent.action, 'scatter');
  assert.equal(agent.order, order, 'dodging preserves the objective');
});

test('holding a distant location means advancing there first, even during contact', () => {
  const { game, agent } = fixture();
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point: { x: 43, y: 52 } });
  const x = agent.x;
  stepGame(game, 0.1);
  assert.equal(agent.action, 'advance');
  assert(agent.x > x, 'the agent starts moving to the ordered position');
});

test('Jev labels advancing as following a hold order until the assigned location is reached', async () => {
  const { game, agent, brains, requests, reply } = fixture();
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point: { x: 43, y: 52 } });
  game.time += 4;
  brains.update(game, 'attack');
  assert.match(requests[0].questions.action.criteria.advance, /carry out your order/);
  assert.doesNotMatch(requests[0].questions.action.criteria.hold, /carry out your order/);
  await reply(0, 'advance');
});

test('after contact ends, an agent returns to its saved hold position without another Jev call', async () => {
  const { game, agent, brains, requests, reply } = fixture();
  setOrder(game, agent, { type: 'hold', zone: 'Attacker Spawn', point: { x: 43, y: 52 } });
  game.time += 4;
  const order = agent.order;
  brains.update(game, 'attack');
  await reply(0, 'cover');
  for (const u of game.units) u.visible = [];
  brains.update(game, 'attack');
  assert.equal(requests.length, 1);
  assert.equal(agent.action, 'advance');
  assert.equal(agent.order, order);
  agent.x = 43;
  brains.update(game, 'attack');
  assert.equal(agent.action, 'hold');
});
