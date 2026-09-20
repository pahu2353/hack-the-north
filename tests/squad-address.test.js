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
  // `everyone` is what Jev answers to the squad-level question. The per-agent answers are
  // still supplied, deliberately including cases where they disagree with it.
  // `everyone` is Jev's answer to the squad-level question. `saysNo` lets the per-agent
  // answers contradict it, which is the case the squad-level question exists to settle.
  const reply = (index, assignments, isOrder = 1, everyone = 0, saysNo = []) => {
    const { questions, resolve } = pending[index];
    const answers = Object.fromEntries(Object.keys(questions).map(key => {
      if (key === 'is_order') return [key, { probability: isOrder }];
      if (key === 'addresses_everyone') return [key, { probability: everyone }];
      const [name, kind] = key.split('_');
      const order = assignments[name];
      return [key, kind === 'addressed' ? { probability: order && !saysNo.includes(name) ? 1 : 0 }
        : { choice: kind === 'order' ? order?.[0] ?? 'hold' : order?.[1] ?? 'current' }];
    }));
    resolve({ answers, latency: 1 });
  };
  return { brains, reply, pending };
}

const asked = questions => Object.keys(questions).filter(k => k.endsWith('_addressed'));
const everyoneOrdered = (order, plan) => plan.every(p => p.applied && p.order === order);

for (const text of ['everyone push B', 'guys push B', 'Everybody push B!', 'all of you push B']) {
  test(`"${text}" moves the whole squad, whatever the per-agent answers say`, async () => {
    const game = createGame();
    const { brains, reply, pending } = harness();
    const run = brains.interpretCommand(game, 'attack', { source: 'voice', text });
    // Whether a sentence speaks to the whole squad is a judgement, so it is a question Jev
    // is asked rather than a list of words matched against the text.
    assert.ok('addresses_everyone' in pending[0].questions, 'the squad question is asked');
    // Three of the five individually answer "not me". The squad-level answer settles it:
    // one sentence with one meaning cannot mobilise two of five.
    const all = Object.fromEntries(['alpha', 'bravo', 'charlie', 'delta', 'echo']
      .map(n => [n, ['push', 'B Site']]));
    reply(0, all, 1, 1, ['charlie', 'delta', 'echo']);
    const { plan } = await run;
    assert.equal(plan.length, 5);
    assert.ok(everyoneOrdered('push', plan), `plan: ${JSON.stringify(plan)}`);
    assert.ok(plan.every(p => p.addressed === 1));
  });
}

test('naming someone alongside "everyone" is settled one agent at a time', async () => {
  const game = createGame();
  const { brains, reply, pending } = harness();
  const run = brains.interpretCommand(game, 'attack', { source: 'voice', text: 'Alpha plant, everyone else hold' });
  assert.deepEqual(asked(pending[0].questions).sort(),
    ['alpha_addressed', 'bravo_addressed', 'charlie_addressed', 'delta_addressed', 'echo_addressed']);
  // "Everyone else" excludes whoever was just named, so it is not a whole-squad order.
  reply(0, { alpha: ['plant', 'B Site'], bravo: ['hold', 'B Site'] }, 1, 0);
  const { plan } = await run;
  assert.equal(plan.find(p => p.name === 'Alpha').order, 'plant');
  assert.equal(plan.find(p => p.name === 'Charlie').applied, false);
});

test('the per-agent questions are always there to fall back on', async () => {
  const game = createGame();
  const { brains, pending } = harness();
  brains.interpretCommand(game, 'attack', { source: 'voice', text: 'everyone else fall back' });
  // Nothing is decided before the call any more, so both layers are always asked and the
  // squad-level answer is what picks between them.
  assert.equal(asked(pending[0].questions).length, 5);
  assert.ok('addresses_everyone' in pending[0].questions);
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

test('in first person a squad word still reaches the whole squad', async () => {
  const game = createGame();
  const { brains, reply, pending } = harness();
  const run = brains.interpretCommand(game, 'attack', { source: 'voice', text: 'everyone push B', only: 'Charlie' });
  // Looking through one agent's eyes does not make the other four stop existing: they are
  // all asked about, and the squad-level answer is what decides.
  assert.equal(asked(pending[0].questions).length, 5);
  const all = Object.fromEntries(['alpha', 'bravo', 'charlie', 'delta', 'echo']
    .map(n => [n, ['push', 'B Site']]));
  reply(0, all, 1, 1);
  const { plan } = await run;
  assert.equal(plan.length, 5);
  assert.ok(everyoneOrdered('push', plan));
});

test('in first person an order that names nobody is for the agent being watched', async () => {
  const game = createGame();
  const { brains, reply } = harness();
  const run = brains.interpretCommand(game, 'attack', { source: 'voice', text: 'hold this angle', only: 'Charlie' });
  // Nobody is picked out and it does not speak to the squad, so it falls to whoever the
  // commander is looking through — and to nobody else.
  reply(0, { charlie: ['hold', 'current'] }, 1, 0);
  const { plan } = await run;
  assert.deepEqual(plan.filter(p => p.applied).map(p => p.name), ['Charlie']);
});

test('in first person naming someone else still reaches them', async () => {
  const game = createGame();
  const { brains, reply } = harness();
  const run = brains.interpretCommand(game, 'attack', { source: 'voice', text: 'Echo fall back', only: 'Charlie' });
  reply(0, { echo: ['retreat', 'Attacker Spawn'] }, 1, 0);
  const { plan } = await run;
  assert.deepEqual(plan.filter(p => p.applied).map(p => p.name), ['Echo'],
    'the watched agent is a fallback, not a filter');
});
