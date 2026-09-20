import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, setOrder, stepGame, teamView } from '../public/commander/sim.js';
import { applyOpponentPlan, opponentDestination, opponentSnapshot, updateOpponentTactics, validateOpponentPlan } from '../public/commander/opponent.js';
import { createOpponentPlan, mockOpponentPlan, parseOpponentSnapshot } from '../opponent.ts';
import { hasLineOfSight } from '../public/commander/world.js';

const bots = game => game.units.filter(u => u.kind === 'bot');
const quiet = game => { for (const u of game.units) u.cooldown = 1000; };
const retakePlan = game => ({ summary: 'Retake together', orders: bots(game).filter(u => u.alive)
  .map(u => ({ unitId: u.id, action: 'retake', zone: game.spike.site })) });
function retakeGame() {
  const game = createGame({ opponent: 'openai' });
  quiet(game);
  Object.assign(game.spike, { state: 'planted', carrierId: null, site: 'B Site', x: 67, y: 14, timer: 35 });
  return game;
}

test('retake waits for most of the bots, releases them together, and survives plan renewals', () => {
  const game = retakeGame();
  const squad = bots(game);
  applyOpponentPlan(game, retakePlan(game));
  const group = game.botRetake;
  assert.equal(group.phase, 'gathering');
  assert.equal(group.required, 4);
  Object.assign(squad[0], group.spots[squad[0].id]);
  updateOpponentTactics(game);
  assert.equal(group.ready, 1);
  assert.deepEqual(opponentDestination(game, squad[0]), group.spots[squad[0].id]);
  assert.notDeepEqual(opponentDestination(game, squad[0]), { x: 67, y: 14 });
  applyOpponentPlan(game, retakePlan(game));
  assert.equal(game.botRetake, group);
  for (const u of squad.slice(1, 4)) Object.assign(u, group.spots[u.id]);
  updateOpponentTactics(game);
  assert.equal(group.phase, 'pushing');
  assert.equal(group.ready, 4);
  for (const u of squad) assert.deepEqual(opponentDestination(game, u), { x: 67, y: 14 });
  applyOpponentPlan(game, retakePlan(game));
  assert.equal(game.botRetake, group);
  assert.equal(game.botRetake.phase, 'pushing');
  assert.equal(parseOpponentSnapshot(opponentSnapshot(game)).coordination.phase, 'pushing');
});

test('retake rally avoids a recently observed sightline when a protected approach is available', () => {
  const game = retakeGame();
  const threat = { x: 40, y: 17, t: game.time };
  game.intel.defend.set(game.units[0].id, threat);
  applyOpponentPlan(game, retakePlan(game));
  assert.equal(game.botRetake.zone, 'Top Hall');
  assert(game.botRetake.point.x > 56); // B's rear hallway, not the west-side zone center
  assert.equal(hasLineOfSight(game.map, threat, game.botRetake.point), false);
});

test('retake releases before travel and defuse time run out, and does not wait for dead teammates', () => {
  const game = retakeGame();
  applyOpponentPlan(game, retakePlan(game));
  game.spike.timer = game.botRetake.travel + 8;
  updateOpponentTactics(game);
  assert.equal(game.botRetake.phase, 'pushing');
  assert.match(game.botRetake.reason, /deadline/);
  const other = retakeGame();
  applyOpponentPlan(other, retakePlan(other));
  for (const u of bots(other).slice(1)) u.alive = false;
  updateOpponentTactics(other);
  assert.equal(other.botRetake.phase, 'pushing');
  assert.equal(other.botRetake.required, 1);
  assert.equal(other.botRetake.unitIds.length, 1);
  assert.doesNotThrow(() => parseOpponentSnapshot(opponentSnapshot(other)));
});

test('an existing defuser is not pulled away to the rally, and cancelled orders clear coordination', () => {
  const game = retakeGame();
  Object.assign(bots(game)[0], { x: 67, y: 14 });
  applyOpponentPlan(game, retakePlan(game));
  assert.equal(game.botRetake.phase, 'pushing');
  assert.match(game.botRetake.reason, /defuser/);
  applyOpponentPlan(game, { orders: bots(game).map(u => ({ unitId: u.id, action: 'hold', zone: 'B Site' })) });
  assert.equal(game.botRetake, null);
});

test('released retakers advance through contact as a group', () => {
  const game = retakeGame();
  applyOpponentPlan(game, retakePlan(game));
  const squad = bots(game);
  for (const u of squad) Object.assign(u, game.botRetake.spots[u.id]);
  const enemy = game.units[0];
  // Place one enemy just beyond the staging position, giving the squad a fair local fight.
  Object.assign(enemy, { x: game.botRetake.point.x + 5, y: game.botRetake.point.y, action: 'hold' });
  setOrder(game, enemy, { type: 'hold', zone: 'B Link', point: { x: enemy.x, y: enemy.y } });
  stepGame(game, 1 / 60);
  assert.equal(game.botRetake.phase, 'pushing');
  assert(squad.some(u => u.visible.includes(enemy)));
  assert(squad.every(u => u.moving));
});

test('expired retake orders clear the rally and use the fallback controller', () => {
  const game = retakeGame();
  applyOpponentPlan(game, retakePlan(game));
  game.time = 13;
  updateOpponentTactics(game);
  assert.equal(game.botRetake, null);
  for (const u of bots(game)) assert.equal(opponentDestination(game, u), null);
});

test('defending against bots swaps ownership, names, fog of war, and spike knowledge', () => {
  const game = createGame({ playerTeam: 'defend', opponent: 'openai' });
  assert.equal(game.botTeam, 'attack');
  assert.deepEqual(game.units.filter(u => u.kind === 'agent').map(u => u.name), ['Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett']);
  assert(bots(game).every(u => u.team === 'attack'));
  const human = game.units.find(u => u.name === 'Foxtrot');
  human.order = { type: 'secret order', zone: 'A Site' };
  game.intel.attack.set(human.id, { x: 12, y: 18, t: 0 });
  const snapshot = parseOpponentSnapshot(opponentSnapshot(game));
  assert.equal(snapshot.team, 'attack');
  assert.equal(snapshot.spike.state, 'carried');
  assert.equal(snapshot.spike.carrierId, bots(game)[0].id);
  assert.deepEqual(snapshot.contacts[0].position, { x: 12, y: 18 });
  assert(!JSON.stringify(snapshot).includes('secret order'));
  assert(!JSON.stringify(snapshot).includes('Foxtrot'));
  assert.deepEqual(teamView(game, 'defend').spike, { state: 'unknown' });
});

function attackGame(opponent) {
  const game = createGame({ playerTeam: 'defend', opponent });
  quiet(game);
  // Park the defenders behind A's cover to leave a clear B plant route.
  for (const u of game.units.filter(u => u.kind === 'agent')) {
    Object.assign(u, { x: 10 + (u.slot % 2) * 2, y: 14.5 + Math.floor(u.slot / 2) * 1.3, action: 'hold' });
    setOrder(game, u, { type: 'hold', zone: 'A Site', point: { x: u.x, y: u.y } });
  }
  return game;
}

for (const opponent of ['openai', 'scripted']) test(`${opponent} attackers can reach a site and plant without player input`, () => {
  const game = attackGame(opponent);
  for (let i = 0; i < 2400 && game.spike.state !== 'planted'; i++) {
    if (opponent === 'openai' && i % 300 === 0) applyOpponentPlan(game, mockOpponentPlan(opponentSnapshot(game)));
    stepGame(game, 1 / 60);
  }
  assert.equal(game.spike.state, 'planted');
  assert.equal(game.spike.site, 'B Site');
  if (opponent === 'openai') {
    const plan = mockOpponentPlan(opponentSnapshot(game));
    assert(plan.orders.every(o => o.action === 'hold' && o.zone === 'B Site'));
  }
});

test('an attacking bot recovers the dropped spike', () => {
  const game = attackGame('openai');
  const carrier = bots(game)[0];
  Object.assign(game.spike, { state: 'dropped', carrierId: null, x: carrier.x + 3, y: carrier.y });
  const snapshot = parseOpponentSnapshot(opponentSnapshot(game));
  assert.equal(snapshot.spike.state, 'dropped');
  applyOpponentPlan(game, mockOpponentPlan(snapshot));
  for (let i = 0; i < 180 && game.spike.state === 'dropped'; i++) stepGame(game, 1 / 60);
  assert.equal(game.spike.state, 'carried');
  assert(bots(game).some(u => u.id === game.spike.carrierId));
});

test('an attacking site push uses Main, a flank uses Link, and nearby bots avoid backtracking', () => {
  const game = attackGame('openai');
  const bot = bots(game)[0];
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'plant', zone: 'A Site' }] });
  assert.deepEqual(opponentDestination(game, bot), { x: 10, y: 30 });
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'flank', zone: 'A Site' }] });
  assert.deepEqual(opponentDestination(game, bot), { x: 28, y: 17.5 });
  Object.assign(bot, { x: 12, y: 18 });
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'plant', zone: 'A Site' }] });
  assert.deepEqual(opponentDestination(game, bot), { x: 12, y: 14 });
});

test('attacking OpenAI receives the attack prompt and cannot return defender-only actions', async () => {
  const snapshot = opponentSnapshot(attackGame('openai'));
  let settings;
  const plan = mockOpponentPlan(snapshot);
  await createOpponentPlan(snapshot, { env: { AI_GATEWAY_API_KEY: 'test-only' },
    generate: async options => { settings = options; return { output: plan }; } });
  assert.match(settings.system, /ATTACKER bots/);
  assert.match(settings.system, /carrier/);
  for (const action of ['retake', 'rotate']) {
    const invalid = structuredClone(plan);
    invalid.orders[0].action = action;
    assert.throws(() => validateOpponentPlan(invalid, snapshot, attackGame('openai').map));
  }
  const invalid = structuredClone(plan);
  invalid.orders[0] = { ...invalid.orders[0], action: 'plant', zone: 'Mid' };
  assert.throws(() => validateOpponentPlan(invalid, snapshot, attackGame('openai').map));
});
