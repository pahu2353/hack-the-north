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

// One canned answer per question, so a command can be interpreted without the network.
function answering({ order, target, addressed = 1 }) {
  return (state, questions) => {
    const answers = {};
    for (const key of Object.keys(questions)) {
      if (key === 'is_order') answers[key] = { probability: 0.95 };
      else if (key.endsWith('_addressed')) answers[key] = { probability: addressed };
      else if (key.endsWith('_order')) answers[key] = { choice: order, probabilities: { [order]: 0.9 } };
      else if (key.endsWith('_target')) answers[key] = { choice: target, probabilities: { [target]: 0.9 } };
    }
    return Promise.resolve({ answers, latency: 1, state, usage: {} });
  };
}

test('an order about the enemy sends the squad to where the enemy was last seen', async () => {
  const game = createGame({ defenders: 'bots', playerTeam: 'attack' });
  const brains = createBrains({ evaluate: answering({ order: 'push', target: 'enemy' }) });
  const [seenLater, seenEarlier] = teamUnits(game, 'defend');
  game.time = 20;
  game.intel.attack.set(seenEarlier.id, { x: 67, y: 14, t: 5 });
  game.intel.attack.set(seenLater.id, { x: 12, y: 14, t: 18 }); // A Site, and more recent
  const result = await brains.interpretCommand(game, 'attack', { source: 'voice', text: 'fight fight fight' });
  assert.equal(result.plan[0].target, 'enemy');
  for (const u of teamUnits(game, 'attack')) {
    assert.equal(u.order.zone, 'A Site', 'the freshest sighting wins, not the oldest');
    assert.ok(Math.hypot(u.order.point.x - 12, u.order.point.y - 14) < 4);
  }
  // The question has to offer it, and say where it leads.
  const asked = [];
  const brains2 = createBrains({ evaluate: (state, questions) => {
    asked.push(questions);
    return answering({ order: 'push', target: 'enemy' })(state, questions);
  } });
  await brains2.interpretCommand(game, 'attack', { source: 'voice', text: 'go at them' });
  assert.match(asked[0].alpha_target.criteria.enemy, /last seen, in A Site/);
});

test('with nobody seen all round, going at the enemy heads for their spawn', async () => {
  const game = createGame({ defenders: 'bots', playerTeam: 'attack' });
  const brains = createBrains({ evaluate: answering({ order: 'push', target: 'enemy' }) });
  await brains.interpretCommand(game, 'attack', { source: 'voice', text: 'push them' });
  const [alpha] = teamUnits(game, 'attack');
  assert.equal(alpha.order.zone, 'Defender Spawn');
});

test('an eliminated enemy is not somewhere to be sent', async () => {
  const game = createGame({ defenders: 'bots', playerTeam: 'attack' });
  const brains = createBrains({ evaluate: answering({ order: 'push', target: 'enemy' }) });
  const [dead, alive] = teamUnits(game, 'defend');
  game.time = 10;
  game.intel.attack.set(dead.id, { x: 12, y: 14, t: 9 }); // seen most recently, but gone
  game.intel.attack.set(alive.id, { x: 67, y: 14, t: 4 });
  dead.alive = false;
  await brains.interpretCommand(game, 'attack', { source: 'voice', text: 'go at the enemy' });
  assert.equal(teamUnits(game, 'attack')[0].order.zone, 'B Site');
});
