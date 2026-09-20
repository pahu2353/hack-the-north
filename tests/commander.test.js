import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import { createPovRenderer } from '../public/commander/pov.js';
import { createGame, pushFeed, setOrder, stepGame, teamView } from '../public/commander/sim.js';

const eliminated = view => view.roster.filter(u => u.down).map(u => u.name);

function commandHarness() {
  const pending = [];
  const brains = createBrains({ evaluate: (state, questions) => new Promise(resolve => {
    pending.push({ questions, resolve });
  }) });
  function reply(index, assignments, isOrder = 1) {
    const { questions, resolve } = pending[index];
    const answers = Object.fromEntries(Object.keys(questions).map(key => {
      if (key === 'is_order') return [key, { probability: isOrder }];
      const [name, kind] = key.split('_');
      const order = assignments[name];
      return [key, kind === 'addressed' ? { probability: order ? 1 : 0 }
        : { choice: kind === 'order' ? order?.[0] ?? 'hold' : order?.[1] ?? 'current' }];
    }));
    resolve({ answers, latency: 1 });
  }
  return { brains, reply };
}

for (const [team, firstName, secondName] of [['attack', 'Alpha', 'Bravo'], ['defend', 'Foxtrot', 'Golf']]) {
  test(`${team}: late squad order preserves a newer individual order, while still reaching other agents`, async () => {
    const game = createGame({ defenders: 'players' });
    const { brains, reply } = commandHarness();
    const old = brains.interpretCommand(game, team, { text: `${firstName} and ${secondName} push A` });
    const latest = brains.interpretCommand(game, team, { text: 'Hold B', only: firstName });
    reply(1, { [firstName.toLowerCase()]: ['hold', 'B Site'] });
    await latest;
    reply(0, { [firstName.toLowerCase()]: ['push', 'A Site'], [secondName.toLowerCase()]: ['push', 'A Site'] });
    const result = await old;
    const first = game.units.find(u => u.name === firstName);
    const second = game.units.find(u => u.name === secondName);
    assert.equal(first.order.type, 'hold');
    assert.equal(first.order.zone, 'B Site');
    assert.equal(second.order.type, 'push');
    assert.equal(second.order.zone, 'A Site');
    assert.equal(result.plan.find(p => p.name === firstName).applied, false);
    assert.match(result.plan.find(p => p.name === firstName).skipReason, /newer order/);
    assert.equal(result.plan.find(p => p.name === secondName).applied, true);
  });
}

test('newer chatter does not cancel an in-flight order', async () => {
  const game = createGame();
  const { brains, reply } = commandHarness();
  const order = brains.interpretCommand(game, 'attack', { text: 'Alpha hold A' });
  const chatter = brains.interpretCommand(game, 'attack', { text: 'Nice shot!' });
  reply(1, {}, 0.1);
  assert.equal((await chatter).ignored, true);
  reply(0, { alpha: ['hold', 'A Site'] });
  assert.equal((await order).plan[0].applied, true);
  assert.equal(game.units[0].order.zone, 'A Site');
});

test('explicit voice sequence rejects a late partial even if it reaches the interpreter last', async () => {
  const game = createGame();
  const { brains, reply } = commandHarness();
  const final = brains.interpretCommand(game, 'attack', { text: 'Alpha hold B', seq: 20 });
  const partial = brains.interpretCommand(game, 'attack', { text: 'Alpha push A', seq: 19 });
  reply(0, { alpha: ['hold', 'B Site'] });
  await final;
  reply(1, { alpha: ['push', 'A Site'] });
  assert.equal((await partial).stale, true);
  assert.equal(game.units[0].order.type, 'hold');
  assert.equal(game.units[0].order.zone, 'B Site');
});

test('explicit sequences remain per-agent and can mix with unnumbered commands', async () => {
  const game = createGame();
  const { brains, reply } = commandHarness();
  const bravo = brains.interpretCommand(game, 'attack', { text: 'Bravo hold B', seq: 30 });
  reply(0, { bravo: ['hold', 'B Site'] });
  await bravo;
  const alpha = brains.interpretCommand(game, 'attack', { text: 'Alpha push A', seq: 29 });
  reply(1, { alpha: ['push', 'A Site'] });
  assert.equal((await alpha).plan[0].applied, true);
  const typed = brains.interpretCommand(game, 'attack', { text: 'Alpha hold A' });
  reply(2, { alpha: ['hold', 'A Site'] });
  assert.equal((await typed).plan[0].applied, true);
  assert.equal(game.units[0].order.type, 'hold');
});

for (const ended of [false, true]) {
  test(`late command does not apply after ${ended ? 'the round ends' : 'the agent dies'}`, async () => {
    const game = createGame();
    const { brains, reply } = commandHarness();
    const original = structuredClone(game.units[0].order);
    const order = brains.interpretCommand(game, 'attack', { text: 'Hold A', only: 'Alpha' });
    if (ended) game.result = { winner: 'defend', reason: 'Time expired' };
    else game.units[0].alive = false;
    reply(0, { alpha: ['hold', 'A Site'] });
    const result = await order;
    assert.equal(result.plan[0].applied, false);
    assert.equal(result.plan[0].skipReason, ended ? 'round ended' : 'agent eliminated');
    assert.deepEqual(game.units[0].order, original);
  });
}

for (const team of ['attack', 'defend']) {
  test(`${team}: confirmed kills survive feed expiry and eviction, without exposing unseen enemies`, t => {
    t.mock.method(Math, 'random', () => 0); // guarantee a hit through the real shooting code
    const game = createGame({ defenders: 'players' });
    const enemyTeam = team === 'attack' ? 'defend' : 'attack';
    const shooter = game.units.find(u => u.team === team);
    const victim = game.units.find(u => u.team === enemyTeam);
    for (const u of game.units) u.cooldown = 100;
    Object.assign(shooter, { x: 10, y: 3, reaction: 0, cooldown: 0, action: 'hold' });
    Object.assign(victim, { x: 12, y: 3, hp: 1 });
    setOrder(game, shooter, { type: 'hold', zone: 'Top Hall', point: { x: 10, y: 3 } });
    assert.deepEqual(eliminated(teamView(game, team)), []);
    stepGame(game, 1 / 60);
    assert.equal(victim.alive, false);
    assert.deepEqual(eliminated(teamView(game, team)), [victim.name]);
    assert.deepEqual(eliminated(teamView(game, enemyTeam)), []);
    // Even a client that missed the kill entirely learns it from the next snapshot.
    for (let i = 0; i < 20; i++) pushFeed(game, 'Unrelated event', team);
    game.time += 9;
    const view = JSON.parse(JSON.stringify(teamView(game, team)));
    assert.equal(view.feed.length, 0);
    assert.deepEqual(eliminated(view), [victim.name]);
    assert(!view.units.some(u => u.id === victim.id));
    assert.deepEqual(eliminated(teamView(createGame(), team)), []);
  });
}

// Count enemy outlines on an unobstructed hallway, exercising the renderer's actual filtering.
function povHarness(t) {
  const oldWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  let outlines = 0;
  const noop = () => {};
  const ctx = new Proxy({
    createLinearGradient: () => ({ addColorStop: noop }),
    strokeRect: () => { outlines++; },
    measureText: () => ({ width: 8 }),
  }, { get: (target, key) => key in target ? target[key] : noop });
  const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 800, height: 600 }) };
  const renderer = createPovRenderer(canvas);
  const alpha = { id: 1, team: 'attack', name: 'Alpha', x: 10, y: 3 };
  const bravo = { id: 2, team: 'attack', name: 'Bravo', x: 60, y: 3 };
  const enemy = { id: 5, team: 'defend', alive: true, name: 'E1', x: 65, y: 3, hp: 100, maxHp: 100 };
  function draw(unit, time, seenBy) {
    outlines = 0;
    renderer.draw({ team: 'attack', time, units: [{ ...enemy, seenBy }], effects: [], spike: null },
      unit, { x: unit.x, y: unit.y, angle: 0 });
    return outlines;
  }
  return { renderer, alpha, bravo, draw };
}

test('POV keeps its brief visibility grace period for the same agent', t => {
  const { bravo, draw } = povHarness(t);
  assert.equal(draw(bravo, 60, [bravo.id]), 1);
  assert.equal(draw(bravo, 60.1, []), 1);
  assert.equal(draw(bravo, 60.5, []), 0);
});

test('switching agents cannot borrow the previous agent sighting', t => {
  const { alpha, bravo, draw } = povHarness(t);
  assert.equal(draw(bravo, 60, [bravo.id]), 1);
  assert.equal(draw(alpha, 60.1, [bravo.id]), 0); // enemy is beyond Alpha's 45m vision
});

test('POV clears old sightings when simulation time restarts', t => {
  const { bravo, draw } = povHarness(t);
  assert.equal(draw(bravo, 60, [bravo.id]), 1);
  assert.equal(draw(bravo, 0.1, []), 0);
});

test('explicit match reset clears POV state even if the first frame has a later time', t => {
  const { renderer, bravo, draw } = povHarness(t);
  assert.equal(draw(bravo, 0.1, [bravo.id]), 1);
  renderer.reset(); // beginMatch calls this for local games and multiplayer rematches
  assert.equal(renderer.toWorld(0, 0), null);
  assert.equal(draw(bravo, 0.2, []), 0);
});
