import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import { createGame } from '../public/commander/sim.js';

// Same shape as the other command tests: Jev's reply is supplied by hand, so what is asserted
// is which questions were asked and what the plan did with the answers.
function harness() {
  const pending = [];
  const brains = createBrains({ evaluate: (state, questions) => new Promise(resolve => {
    pending.push({ state, questions, resolve });
  }) });
  const reply = (index, assignments, isOrder = 1) => {
    const { questions, resolve } = pending[index];
    const answers = Object.fromEntries(Object.keys(questions).map(key => {
      if (key === 'is_order') return [key, { probability: isOrder }];
      const [name, kind] = key.split('_');
      const order = assignments[name];
      return [key, kind === 'addressed' ? { probability: order ? 1 : 0 }
        : { choice: kind === 'order' ? order?.[0] ?? 'hold' : order?.[1] ?? 'current' }];
    }));
    resolve({ answers, latency: 1 });
  };
  return { brains, reply, pending };
}

const asked = questions => Object.keys(questions).filter(k => k.endsWith('_addressed'));
const everyoneOrdered = (order, plan) => plan.every(p => p.applied && p.order === order);

for (const text of ['everyone push B', 'guys push B', 'Everybody push B!', 'all of you push B']) {
  test(`"${text}" moves the whole squad without asking who it is for`, async () => {
    const game = createGame();
    const { brains, reply, pending } = harness();
    const run = brains.interpretCommand(game, 'attack', { source: 'voice', text });
    // Nobody is named and the squad is addressed as a whole, so the per-agent question is
    // never asked — five fewer questions, and no chance of a split answer.
    assert.deepEqual(asked(pending[0].questions), []);
    reply(0, Object.fromEntries(['alpha', 'bravo', 'charlie', 'delta', 'echo']
      .map(n => [n, ['push', 'B Site']])));
    const { plan } = await run;
    assert.equal(plan.length, 5);
    assert.ok(everyoneOrdered('push', plan), `plan: ${JSON.stringify(plan)}`);
    assert.ok(plan.every(p => p.addressed === 1));
  });
}

test('naming someone alongside "everyone" still goes to Jev, one agent at a time', async () => {
  const game = createGame();
  const { brains, reply, pending } = harness();
  const run = brains.interpretCommand(game, 'attack', { source: 'voice', text: 'Alpha plant, everyone else hold' });
  assert.deepEqual(asked(pending[0].questions).sort(),
    ['alpha_addressed', 'bravo_addressed', 'charlie_addressed', 'delta_addressed', 'echo_addressed']);
  reply(0, { alpha: ['plant', 'B Site'], bravo: ['hold', 'B Site'] });
  const { plan } = await run;
  assert.equal(plan.find(p => p.name === 'Alpha').order, 'plant');
  assert.equal(plan.find(p => p.name === 'Charlie').applied, false);
});

test('"everyone else" alone is left to Jev, since it excludes whoever was just named', async () => {
  const game = createGame();
  const { brains, pending } = harness();
  brains.interpretCommand(game, 'attack', { source: 'voice', text: 'everyone else fall back' });
  assert.equal(asked(pending[0].questions).length, 5);
});

test('chatter that happens to say "guys" is still chatter', async () => {
  const game = createGame();
  const { brains, reply, pending } = harness();
  const run = brains.interpretCommand(game, 'attack', { source: 'voice', text: 'nice shot guys' });
  reply(0, {}, 0.05); // is_order says no
  const result = await run;
  assert.equal(result.ignored, true);
  assert.deepEqual(result.plan, []);
});

test('in first person a squad word still addresses only the agent being watched', async () => {
  const game = createGame();
  const { brains, reply, pending } = harness();
  const run = brains.interpretCommand(game, 'attack', { source: 'voice', text: 'everyone push B', only: 'Charlie' });
  assert.deepEqual(asked(pending[0].questions), []);
  reply(0, { charlie: ['push', 'B Site'] });
  const { plan } = await run;
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, 'Charlie');
});
