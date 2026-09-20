import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpponentPlan, mockOpponentPlan, parseOpponentSnapshot } from '../opponent.ts';
import { PREP_SECONDS, ROUND_SECONDS, createGame, setOrder, stepGame } from '../public/commander/sim.js';
import {
  applyOpponentPlan, createOpponentCommander, defenderCombat, opponentDestination, opponentSnapshot,
  PLAN_LIFETIME, validateOpponentPlan,
} from '../public/commander/opponent.js';

const makeGame = () => createGame({ defenders: 'bots', opponent: 'openai' });
const bots = game => game.units.filter(u => u.kind === 'bot');
const answer = (game, overrides = {}) => ({ plan: mockOpponentPlan(opponentSnapshot(game)), model: 'test-model', mock: false, ...overrides });
const response = data => ({ ok: true, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('OpenAI gets the full live round time after setup, on either side', () => {
  for (const playerTeam of ['attack', 'defend']) {
    const game = createGame({ defenders: 'bots', opponent: 'openai', playerTeam, prep: true });
    game.time = PREP_SECONDS - 1;
    assert.equal(opponentSnapshot(game).secondsLeft, ROUND_SECONDS);
    game.time = PREP_SECONDS;
    assert.equal(opponentSnapshot(game).secondsLeft, ROUND_SECONDS);
    game.time += 23;
    assert.equal(opponentSnapshot(game).secondsLeft, ROUND_SECONDS - 23);
  }
});

test('snapshot includes only defender knowledge and the public planted objective', () => {
  const game = makeGame();
  game.time = 10;
  const attacker = game.units[0];
  attacker.x = 66; attacker.y = 30;
  attacker.order = { type: 'secret', zone: 'B Site' };
  game.pointer = { x: 72, y: 4 };
  game.intel.defend.set(attacker.id, { x: 40, y: 34, t: 7 });
  game.intel.defend.set(game.units[1].id, { x: 5, y: 5, t: 1 });
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
  snapshot.squad[0].secret = 'not allowed';
  snapshot.spike.carrierId = 1;
  const parsed = parseOpponentSnapshot(snapshot);
  assert(!JSON.stringify(parsed).includes('not allowed'));
  assert.deepEqual(parsed.spike, { state: 'unplanted' });
  for (const invalid of [null, {}, { ...snapshot, contacts: [{}] }, { ...snapshot, squad: [snapshot.squad[0], snapshot.squad[0]] }, { ...snapshot, time: NaN }]) {
    assert.throws(() => parseOpponentSnapshot(invalid), /Invalid opponent/);
  }
});

test('combat facts use visible enemies and nearby allies with sightlines; the server validates and sanitizes them', () => {
  const game = makeGame();
  const [anchor, nearby, blocked, distant] = bots(game);
  Object.assign(anchor, { x: 12, y: 18 });
  Object.assign(nearby, { x: 10, y: 18 });
  Object.assign(blocked, { x: 20, y: 17 });
  Object.assign(distant, { x: 70, y: 8 });
  game.units[1].alive = false;
  anchor.visible = [game.units[0], game.units[1]];
  assert.deepEqual(defenderCombat(game, anchor), { visibleEnemies: 1, nearbyAllies: 1, fallingBack: false });
  blocked.visible = [game.units[0]];
  assert.equal(defenderCombat(game, anchor).nearbyAllies, 2); // shared crossfire counts despite the wall between allies
  blocked.visible = [];
  const snapshot = opponentSnapshot(game);
  snapshot.squad[0].combat.extra = 'strip this';
  const parsed = parseOpponentSnapshot(snapshot);
  assert.deepEqual(parsed.squad[0].combat, { visibleEnemies: 1, nearbyAllies: 1, fallingBack: false });
  for (const combat of [
    { visibleEnemies: -1, nearbyAllies: 0, fallingBack: false },
    { visibleEnemies: 1, nearbyAllies: 99, fallingBack: false },
    { visibleEnemies: 1, nearbyAllies: 0, fallingBack: 'yes' },
  ]) {
    const invalid = structuredClone(snapshot);
    invalid.squad[0].combat = combat;
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

test('holding the current site keeps an existing angle; regroup continues moving under fire', () => {
  const game = makeGame();
  const anchor = bots(game)[0];
  const original = { x: anchor.x, y: anchor.y };
  applyOpponentPlan(game, { orders: [{ unitId: anchor.id, action: 'hold', zone: 'A Site' }] });
  assert.deepEqual(opponentDestination(game, anchor), original);
  stepGame(game, 1 / 60);
  assert.equal(anchor.moving, false);
  Object.assign(game.units[0], { x: 12, y: 9, cooldown: 100 });
  applyOpponentPlan(game, { orders: [{ unitId: anchor.id, action: 'regroup', zone: 'A Link' }] });
  const before = { x: anchor.x, y: anchor.y };
  stepGame(game, 1 / 60);
  assert(anchor.visible.includes(game.units[0]));
  assert(Math.hypot(anchor.x - before.x, anchor.y - before.y) > 0);
  assert.equal(anchor.botFallback, null);
});

function rushFixture({ grouped = false, opponent = 'openai' } = {}) {
  const game = createGame({ defenders: 'bots', opponent });
  const defenders = bots(game);
  for (const [i, u] of game.units.filter(u => u.team === 'attack').entries()) {
    Object.assign(u, { x: 9 + i * 1.1, y: 25, action: 'fight', cooldown: 100 });
    setOrder(game, u, { type: 'hold', zone: 'A Main', point: { x: u.x, y: u.y } });
  }
  for (const [i, u] of defenders.entries()) {
    Object.assign(u, grouped ? { x: 9 + i * 1.3, y: 18 } : i === 0 ? { x: 12, y: 18 } : { x: 67 + i * 2, y: 8 });
    u.cooldown = 100;
  }
  applyOpponentPlan(game, { orders: defenders.map((u, i) => ({ unitId: u.id, action: 'hold', zone: grouped || i === 0 ? 'A Site' : 'B Site' })) });
  return game;
}

test('a healthy isolated OpenAI defender immediately escapes a rush and stays in cover after losing sight', () => {
  const game = rushFixture();
  const anchor = bots(game)[0];
  stepGame(game, 1 / 60);
  assert.equal(anchor.hp, anchor.maxHp);
  assert.equal(anchor.visible.length, 5);
  assert.equal(anchor.moving, true);
  assert(anchor.botFallback);
  const fallback = anchor.botFallback;
  assert.deepEqual(opponentSnapshot(game).squad[0].combat, { visibleEnemies: 5, nearbyAllies: 0, fallingBack: true });
  // Break contact while keeping the original hold order. The bot must not immediately re-peek.
  for (const [i, attacker] of game.units.filter(u => u.team === 'attack').entries()) {
    Object.assign(attacker, { x: 66 + i * 2, y: 50 });
    setOrder(game, attacker, { type: 'hold', zone: 'Attacker Spawn', point: { x: attacker.x, y: attacker.y } });
  }
  Object.assign(anchor, fallback.point);
  for (let i = 0; i < 60; i++) stepGame(game, 1 / 60);
  assert.equal(anchor.visible.length, 0);
  assert.equal(anchor.botFallback, fallback);
  assert.equal(anchor.moving, false);
  assert(Math.hypot(anchor.x - fallback.point.x, anchor.y - fallback.point.y) < 0.8);
  game.time = fallback.until;
  stepGame(game, 1 / 60);
  assert.equal(anchor.botFallback, null);
  assert.equal(anchor.moving, true); // resumes its order after the recovery window
});

test('supported defenders stand their ground in a fair fight; scripted mode retains its original behavior', () => {
  const together = rushFixture({ grouped: true });
  stepGame(together, 1 / 60);
  assert(bots(together).every(u => !u.botFallback && !u.moving));
  assert.equal(defenderCombat(together, bots(together)[0]).nearbyAllies, 4);
  const scripted = rushFixture({ opponent: 'scripted' });
  stepGame(scripted, 1 / 60);
  assert.equal(bots(scripted)[0].hp, bots(scripted)[0].maxHp);
  assert.equal(bots(scripted)[0].moving, false);
  assert(!bots(scripted)[0].botFallback);
});

test('arriving support lets a withdrawing defender resume the fight before its recovery timer expires', () => {
  const game = rushFixture();
  const [anchor, support] = bots(game);
  for (const [i, attacker] of game.units.slice(2, 5).entries()) {
    Object.assign(attacker, { x: 68 + i * 2, y: 50 });
    setOrder(game, attacker, { type: 'hold', zone: 'Attacker Spawn', point: { x: attacker.x, y: attacker.y } });
  }
  stepGame(game, 1 / 60);
  assert.equal(anchor.botFallback.enemies, 2);
  const recoveryUntil = anchor.botFallback.until;
  Object.assign(support, { x: anchor.x - 1.5, y: anchor.y });
  applyOpponentPlan(game, { orders: [{ unitId: support.id, action: 'hold', zone: 'A Site' }] });
  stepGame(game, 1 / 60);
  assert(game.time < recoveryUntil);
  assert.equal(defenderCombat(game, anchor).nearbyAllies, 1);
  assert.equal(anchor.botFallback, null);
  assert.equal(anchor.moving, false);
});

test('renewed flank orders preserve completed waypoints, paths and cover; changed orders get a new route', () => {
  const game = makeGame();
  const bot = bots(game)[0];
  const flank = { orders: [{ unitId: bot.id, action: 'flank', zone: 'B Site' }] };
  applyOpponentPlan(game, flank);
  Object.assign(bot, opponentDestination(game, bot)); // arrive at B Link
  assert.deepEqual(opponentDestination(game, bot), { x: 67, y: 14 });
  bot.x = 60; bot.y = 17;
  const ongoing = bot.botOrder;
  const path = bot.path = [{ x: 65, y: 17 }];
  const goal = bot.pathGoal = { x: 67, y: 14 };
  const cover = bot.coverPoint = { x: 60, y: 15 };
  game.time = 5;
  applyOpponentPlan(game, flank);
  assert.equal(bot.botOrder, ongoing);
  assert.equal(bot.botOrder.expiresAt, game.time + PLAN_LIFETIME);
  assert.deepEqual(opponentDestination(game, bot), { x: 67, y: 14 });
  assert.equal(bot.path, path);
  assert.equal(bot.pathGoal, goal);
  assert.equal(bot.coverPoint, cover);

  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'flank', zone: 'A Site' }] });
  assert.notEqual(bot.botOrder, ongoing);
  assert.deepEqual(opponentDestination(game, bot), { x: 28, y: 17.5 });
  assert.equal(bot.pathGoal, null);
  assert.equal(bot.coverPoint, null);
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'hold', zone: 'A Site' }] });
  assert.equal(bot.botOrder.via, null);

  applyOpponentPlan(game, flank);
  Object.assign(bot, opponentDestination(game, bot));
  opponentDestination(game, bot);
  const expired = bot.botOrder;
  game.time = expired.expiresAt;
  applyOpponentPlan(game, flank);
  assert.notEqual(bot.botOrder, expired); // expired orders have already yielded to scripted behavior
});

test('scripted opponents do not call the LLM', () => {
  const commander = createOpponentCommander({ request: () => { throw new Error('Unexpected request'); } });
  assert.equal(commander.update(createGame({ defenders: 'bots' })), undefined);
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

test('new sightings are batched and rate limited; refreshed sightings and visibility flicker do not replan', async () => {
  const game = makeGame();
  let now = 0;
  const sent = [];
  const commander = createOpponentCommander({ now: () => now, request: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return response(answer(game));
  } });
  await commander.update(game);
  assert.equal(game.botCommander.reason, 'Opening defense');
  now = 1000;
  game.intel.defend.set(game.units[0].id, { x: 70, y: 30, t: game.time });
  commander.update(game);
  now = 1200;
  game.intel.defend.set(game.units[1].id, { x: 71, y: 30, t: game.time });
  commander.update(game);
  now = 1500;
  commander.update(game);
  assert.equal(sent.length, 1); // debounce passed, but not the minimum request interval
  now = 2000;
  await commander.update(game);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].contacts.length, 2);
  assert.equal(game.botCommander.reason, '2 enemies spotted at B Main');

  for (now = 2300; now < 6900; now += 100) {
    game.time = now / 1000;
    game.units[0].x = 12; // hidden movement never becomes defender intel
    bots(game)[0].visible = now % 200 ? [] : [game.units[1]];
    game.intel.defend.set(game.units[1].id, { x: 71, y: 30, t: game.time });
    commander.update(game);
  }
  assert.equal(sent.length, 2);
});

test('a known attacker seen in a new zone triggers an early plan after the debounce', async () => {
  const game = makeGame();
  let now = 0;
  let calls = 0;
  game.intel.defend.set(game.units[0].id, { x: 40, y: 34, t: 0 });
  const commander = createOpponentCommander({ now: () => now, request: async () => { calls++; return response(answer(game)); } });
  await commander.update(game);
  now = 2500;
  game.intel.defend.set(game.units[0].id, { x: 70, y: 30, t: 0 });
  commander.update(game);
  now = 2849;
  commander.update(game);
  assert.equal(calls, 1);
  now = 2850;
  await commander.update(game);
  assert.equal(calls, 2);
  assert.equal(game.botCommander.reason, '1 enemy spotted at B Main');
});

test('an emergency fallback triggers a debounced support plan without repeatedly requesting the same event', async () => {
  const game = makeGame();
  let now = 0;
  let calls = 0;
  const commander = createOpponentCommander({ now: () => now, request: async () => { calls++; return response(answer(game)); } });
  await commander.update(game);
  now = 2500;
  bots(game)[0].botFallback = { point: { x: 12, y: 8 }, until: 4, enemies: 4, allies: 1 };
  commander.update(game);
  assert.equal(calls, 1);
  now = 2850;
  await commander.update(game);
  assert.equal(calls, 2);
  assert.equal(game.botCommander.reason, 'E1 taking cover');
  now = 5000;
  commander.update(game);
  assert.equal(calls, 2);
});

test('casualties and sightings during an outstanding request trigger a fresh plan without overlapping calls', async () => {
  const game = makeGame();
  let now = 0;
  const waiting = deferred();
  const sent = [];
  const commander = createOpponentCommander({ now: () => now, request: (_url, options) => {
    sent.push(JSON.parse(options.body));
    return sent.length === 1 ? waiting.promise : Promise.resolve(response(answer(game)));
  } });
  const first = commander.update(game);
  const oldAnswer = answer(game);
  now = 1000;
  bots(game)[0].alive = false;
  game.intel.defend.set(game.units[0].id, { x: 70, y: 30, t: 0 });
  commander.update(game);
  now = 3500;
  commander.update(game);
  assert.equal(sent.length, 1);
  waiting.resolve(response(oldAnswer));
  await first;
  const followup = commander.update(game);
  assert.equal(game.botCommander.planningReason, 'E1 eliminated · 1 enemy spotted at B Main');
  assert.equal(game.botCommander.reason, 'Opening defense'); // old plan's reason stays with its summary
  await followup;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].squad.length, 4);
  assert.equal(game.botCommander.reason, 'E1 eliminated · 1 enemy spotted at B Main');
  assert.equal(game.botCommander.orders.length, 4);
  assert(!bots(game)[0].botOrder);
  now = 5500;
  commander.update(game);
  assert.equal(sent.length, 2); // the same casualty does not retrigger
});

test('combat and plant events respect failure backoff, then recover using current intel', async () => {
  const game = makeGame();
  let now = 0;
  let calls = 0;
  const commander = createOpponentCommander({ now: () => now, request: async () => response(++calls === 1 ? { plan: {} } : answer(game)) });
  await commander.update(game);
  now = 2000;
  bots(game)[0].alive = false;
  game.intel.defend.set(game.units[0].id, { x: 70, y: 30, t: 0 });
  Object.assign(game.spike, { state: 'planted', site: 'B Site', x: 67, y: 14 });
  commander.update(game);
  now = 9999;
  commander.update(game);
  assert.equal(calls, 1);
  now = 10000;
  await commander.update(game);
  assert.equal(calls, 2);
  assert.equal(game.botCommander.status, 'active');
  assert.equal(game.botCommander.orders.length, 4);
  assert(bots(game).filter(u => u.alive).every(u => u.botOrder.action === 'retake'));
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
  assert.equal(result.plan.orders.length, 5);
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
  assert.equal(requestBody.text.format.schema.properties.orders.maxItems, 5);
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
  assert.equal(settings.model, 'openai/gpt-5.6-sol');
  assert.equal(settings.providerOptions.openai.reasoningEffort, 'low');
  assert.equal(settings.maxRetries, 0);
  assert(settings.abortSignal);
  assert.deepEqual(result.plan, expected);
});

test('direct OpenAI uses low reasoning for Sol and Astra and omits it for a GPT-4.1 override', async () => {
  const game = makeGame();
  for (const [model, reasoning] of [[undefined, { effort: 'low' }], ['gpt-6-astra', { effort: 'low' }], ['gpt-4.1-mini', undefined]]) {
    let body;
    await createOpponentPlan(opponentSnapshot(game), {
      env: { OPENAI_API_KEY: 'test-only', ...(model ? { OPENAI_BOT_MODEL: model } : {}) },
      request: async (_url, options) => {
        body = JSON.parse(options.body);
        return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer(game).plan) }] }] });
      },
    });
    assert.equal(body.model, model ?? 'gpt-5.6-sol');
    assert.deepEqual(body.reasoning, reasoning);
  }
});
