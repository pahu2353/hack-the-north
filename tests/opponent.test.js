import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpponentPlan, mockOpponentPlan, parseOpponentSnapshot } from '../opponent.ts';
import { createGame, stepGame } from '../public/commander/sim.js';
import {
  applyOpponentPlan, createOpponentCommander, opponentDestination, opponentSnapshot,
  PLAN_LIFETIME, validateOpponentPlan,
} from '../public/commander/opponent.js';

const makeGame = () => createGame('tactical', { opponent: 'openai' });
const bots = game => game.units.filter(u => u.kind === 'bot');
const answer = (game, overrides = {}) => ({ plan: mockOpponentPlan(opponentSnapshot(game)), model: 'test-model', mock: false, ...overrides });
const response = data => ({ ok: true, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('snapshot includes only defender knowledge and the public planted objective', () => {
  const game = makeGame();
  game.time = 10;
  const attacker = game.units[0];
  attacker.x = 66; attacker.y = 30;
  attacker.order = { type: 'secret', zone: 'B Site' };
  game.pointer = { x: 72, y: 4 };
  game.enemyIntel.set(attacker.id, { x: 40, y: 34, t: 7 });
  game.enemyIntel.set(game.units[1].id, { x: 5, y: 5, t: 1 });
  const snapshot = opponentSnapshot(game);
  assert.deepEqual(snapshot.spike, { state: 'unplanted' });
  assert.deepEqual(snapshot.contacts, [{ id: attacker.id, position: { x: 40, y: 34 }, zone: 'Mid', age: 3, visible: false }]);
  assert(!JSON.stringify(snapshot).includes('secret'));
  assert(!JSON.stringify(snapshot).includes('Alpha'));
  assert(!JSON.stringify(snapshot).includes('66'));
  game.spike = { ...game.spike, state: 'planted', x: 67, y: 14, site: 'B Site', timer: 30 };
  assert.deepEqual(opponentSnapshot(game).spike, { state: 'planted', site: 'B Site', position: { x: 67, y: 14 }, secondsLeft: 30 });
});

test('input validation strips extra information and rejects invalid snapshots', () => {
  const snapshot = opponentSnapshot(makeGame());
  snapshot.playerOrders = 'not allowed';
  snapshot.defenders[0].secret = 'not allowed';
  snapshot.spike.carrierId = 1;
  const parsed = parseOpponentSnapshot(snapshot);
  assert(!JSON.stringify(parsed).includes('not allowed'));
  assert.deepEqual(parsed.spike, { state: 'unplanted' });
  for (const invalid of [null, {}, { ...snapshot, contacts: [{}] }, { ...snapshot, defenders: [snapshot.defenders[0], snapshot.defenders[0]] }, { ...snapshot, time: NaN }]) {
    assert.throws(() => parseOpponentSnapshot(invalid), /Invalid opponent/);
  }
});

test('plan validation rejects missing/duplicate units, unknown actions and impossible retakes', () => {
  const game = makeGame();
  const snapshot = opponentSnapshot(game);
  const plan = mockOpponentPlan(snapshot);
  assert.deepEqual(validateOpponentPlan(plan, snapshot, game.map), plan);
  for (const mutate of [
    p => p.orders.pop(),
    p => { p.orders[1].unitId = p.orders[0].unitId; },
    p => { p.orders[0].unitId = game.units[0].id; },
    p => { p.orders[0].action = 'teleport'; },
    p => { p.orders[0].action = 'retake'; },
    p => { p.orders[0].zone = 'Unknown zone'; },
  ]) {
    const invalid = structuredClone(plan);
    mutate(invalid);
    assert.throws(() => validateOpponentPlan(invalid, snapshot, game.map));
  }
});

test('OpenAI plan reaches deterministic movement; expired orders return to scripted posts', () => {
  const game = makeGame();
  const bot = bots(game)[0];
  const origin = { x: bot.x, y: bot.y };
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'rotate', zone: 'Top Hall' }] });
  for (let i = 0; i < 120; i++) stepGame(game, 1 / 60);
  assert(Math.hypot(bot.x - origin.x, bot.y - origin.y) > 2);
  const distanceFromPost = Math.hypot(bot.x - origin.x, bot.y - origin.y);
  game.time = PLAN_LIFETIME + 1;
  assert.equal(opponentDestination(game, bot), null);
  for (let i = 0; i < 90; i++) stepGame(game, 1 / 60);
  assert(Math.hypot(bot.x - origin.x, bot.y - origin.y) < distanceFromPost);
});

test('retreat moves under fire, flank uses a Link, retake aims at the actual spike', () => {
  const game = makeGame();
  const bot = bots(game)[0];
  const attacker = game.units[0];
  attacker.x = 12; attacker.y = 9;
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'retreat', zone: 'Top Hall' }] });
  const before = { x: bot.x, y: bot.y };
  stepGame(game, 1 / 60);
  assert(bot.visible.includes(attacker));
  assert(Math.hypot(bot.x - before.x, bot.y - before.y) > 0);
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'flank', zone: 'B Site' }] });
  assert.deepEqual(opponentDestination(game, bot), { x: 52, y: 17.5 });
  Object.assign(game.spike, { state: 'planted', x: 70, y: 18, site: 'B Site' });
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'retake', zone: 'B Site' }] });
  assert.deepEqual(opponentDestination(game, bot), { x: 70, y: 18 });
});

test('scripted opponents and Titan Siege do not call the LLM', () => {
  const commander = createOpponentCommander({ request: () => { throw new Error('Unexpected request'); } });
  assert.equal(commander.update(createGame('tactical')), undefined);
  const titan = createGame('titan', { opponent: 'openai' });
  assert.equal(titan.opponent, 'scripted');
  assert.equal(commander.update(titan), undefined);
});

test('one outstanding request, throttled replanning, and mock labeling', async () => {
  const game = makeGame();
  let calls = 0;
  let now = 0;
  const waiting = deferred();
  const commander = createOpponentCommander({ now: () => now, request: () => { calls++; return waiting.promise; } });
  const pending = commander.update(game);
  commander.update(game);
  assert.equal(calls, 1);
  assert.equal(game.botCommander.status, 'thinking');
  now = 100;
  waiting.resolve(response(answer(game, { mock: true })));
  await pending;
  assert.equal(game.botCommander.status, 'mock');
  assert.equal(game.botCommander.latency, 100);
  assert(bots(game).every(u => u.botOrder));
  commander.update(game);
  assert.equal(calls, 1);
  now = 5100;
  await commander.update(game);
  assert.equal(calls, 2);
});

test('restart aborts a request and prevents a late response from modifying either game', async () => {
  const oldGame = makeGame();
  const waiting = deferred();
  let signal;
  const commander = createOpponentCommander({ request: (_url, options) => { signal = options.signal; return waiting.promise; } });
  const pending = commander.update(oldGame);
  commander.reset();
  const newGame = makeGame();
  assert(signal.aborted);
  waiting.resolve(response(answer(oldGame)));
  await pending;
  assert(bots(oldGame).every(u => !u.botOrder));
  assert(bots(newGame).every(u => !u.botOrder));
});

test('a plant during a request discards the obsolete plan and replans immediately', async () => {
  const game = makeGame();
  const waiting = deferred();
  let calls = 0;
  const commander = createOpponentCommander({ request: () => ++calls === 1 ? waiting.promise : Promise.resolve(response(answer(game))) });
  const pending = commander.update(game);
  const oldAnswer = answer(game);
  Object.assign(game.spike, { state: 'planted', site: 'B Site', x: 67, y: 14 });
  waiting.resolve(response(oldAnswer));
  await pending;
  assert(bots(game).every(u => !u.botOrder));
  await commander.update(game);
  assert.equal(calls, 2);
  assert(bots(game).every(u => u.botOrder.action === 'retake'));
});

test('aged responses are discarded and dead defenders are not given orders', async () => {
  const game = makeGame();
  const waiting = deferred();
  const commander = createOpponentCommander({ request: () => waiting.promise });
  const pending = commander.update(game);
  const original = answer(game);
  game.time = PLAN_LIFETIME + 1;
  waiting.resolve(response(original));
  await pending;
  assert(bots(game).every(u => !u.botOrder));

  const next = deferred();
  const another = createOpponentCommander({ request: () => next.promise });
  const pendingNext = another.update(game);
  const accepted = answer(game);
  bots(game)[0].alive = false;
  next.resolve(response(accepted));
  await pendingNext;
  assert(!bots(game)[0].botOrder);
  assert(bots(game).slice(1).every(u => u.botOrder));
});

test('invalid response clears old plans; scripted fallback remains playable and recovers', async () => {
  const game = makeGame();
  let now = 0;
  let fail = true;
  applyOpponentPlan(game, answer(game).plan);
  const commander = createOpponentCommander({ now: () => now, request: async () => response(fail ? { plan: {} } : answer(game)) });
  await commander.update(game);
  assert.equal(game.botCommander.status, 'fallback');
  assert(bots(game).every(u => !u.botOrder));
  assert.doesNotThrow(() => stepGame(game, 1 / 60));
  assert.equal(commander.update(game), undefined);
  fail = false;
  now = 10_000;
  await commander.update(game);
  assert.equal(game.botCommander.status, 'active');
});

test('request timeout activates fallback instead of leaving the loop pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const game = makeGame();
  const commander = createOpponentCommander({ request: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const pending = commander.update(game);
  t.mock.timers.tick(9000);
  await pending;
  assert.equal(game.botCommander.status, 'fallback');
  assert.match(game.botCommander.error, /timed out/);
});

test('API supports explicitly labeled mock plans and fails clearly without a key', async () => {
  const snapshot = opponentSnapshot(makeGame());
  const result = await createOpponentPlan(snapshot, { mock: true, env: {} });
  assert.equal(result.mock, true);
  assert.equal(result.plan.orders.length, 4);
  await assert.rejects(createOpponentPlan(snapshot, { env: {} }), /Set OPENAI_API_KEY or AI_GATEWAY_API_KEY/);
});

test('direct OpenAI request uses bounded structured output and validates the returned plan', async () => {
  const game = makeGame();
  const snapshot = opponentSnapshot(game);
  const expected = answer(game).plan;
  let requestBody;
  const result = await createOpponentPlan(snapshot, {
    env: { OPENAI_API_KEY: 'test-only', OPENAI_BOT_MODEL: 'test-model' },
    request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      requestBody = JSON.parse(options.body);
      assert.equal(options.headers.authorization, 'Bearer test-only');
      return response({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(expected) }] }] });
    },
  });
  assert.equal(requestBody.model, 'test-model');
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.text.format.schema.properties.orders.maxItems, 4);
  assert.deepEqual(result.plan, expected);
  assert.equal(result.mock, false);
});

test('incomplete/refused OpenAI responses fail safely', async () => {
  const snapshot = opponentSnapshot(makeGame());
  for (const body of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'No plan' }] }] }]) {
    await assert.rejects(createOpponentPlan(snapshot, { env: { OPENAI_API_KEY: 'test-only' }, request: async () => response(body) }), /OpenAI/);
  }
});

test('existing AI Gateway credentials can run the OpenAI opponent', async () => {
  const game = makeGame();
  let settings;
  const expected = answer(game).plan;
  const result = await createOpponentPlan(opponentSnapshot(game), {
    env: { AI_GATEWAY_API_KEY: 'test-only' },
    generate: async options => { settings = options; return { output: expected }; },
  });
  assert.equal(settings.model, 'openai/gpt-5.6-luna');
  assert.equal(settings.providerOptions.openai.reasoningEffort, 'low');
  assert.equal(settings.maxRetries, 0);
  assert(settings.abortSignal);
  assert.deepEqual(result.plan, expected);
});

test('direct OpenAI uses low reasoning for Luna and omits it for a GPT-4.1 override', async () => {
  const game = makeGame();
  for (const [model, reasoning] of [[undefined, { effort: 'low' }], ['gpt-4.1-mini', undefined]]) {
    let body;
    await createOpponentPlan(opponentSnapshot(game), {
      env: { OPENAI_API_KEY: 'test-only', ...(model ? { OPENAI_BOT_MODEL: model } : {}) },
      request: async (_url, options) => {
        body = JSON.parse(options.body);
        return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer(game).plan) }] }] });
      },
    });
    assert.equal(body.model, model ?? 'gpt-5.6-luna');
    assert.deepEqual(body.reasoning, reasoning);
  }
});
