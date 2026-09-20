import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpponentPlan, mockOpponentPlan, parseOpponentSnapshot } from '../opponent.ts';
import { createGame, GRENADE, incomingGrenade, otherTeam, setOrder, stepGame, throwGrenade } from '../public/commander/sim.js';
import { applyOpponentPlan, createOpponentCommander, opponentSnapshot } from '../public/commander/opponent.js';
import { dist, zoneAt } from '../public/commander/world.js';

const bots = game => game.units.filter(u => u.kind === 'bot');
const humans = game => game.units.filter(u => u.kind === 'agent');
const response = data => ({ ok: true, json: async () => data });
const answer = game => ({ plan: mockOpponentPlan(opponentSnapshot(game)), model: 'test-model' });
const step = (game, seconds) => {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) stepGame(game, 1 / 60);
};
function quietGame(team = 'defend') {
  const game = createGame({ opponent: 'openai', playerTeam: otherTeam(team) });
  for (const u of game.units) Object.assign(u, { cooldown: 1000, grenades: 0 });
  humans(game).forEach((u, i) => {
    Object.assign(u, { x: 10 + i * 1.5, y: 12, action: 'hold' });
    setOrder(game, u, { type: 'hold', zone: 'A Site', point: { x: u.x, y: u.y } });
  });
  bots(game).forEach((u, i) => Object.assign(u, i === 0 ? { x: 40, y: 46 } : { x: 65 + i * 2, y: 50 }));
  applyOpponentPlan(game, { orders: bots(game).map(u => ({ unitId: u.id, action: 'hold', zone: zoneAt(game.map, u).name })) });
  return game;
}
function landed(game, { team = otherTeam(game.botTeam), x = 40, y = 46 } = {}) {
  const grenade = { id: game.nextId++, team, x, y, explodeAt: game.time + GRENADE.fuse };
  game.grenades.push(grenade);
  return grenade;
}

for (const team of ['attack', 'defend']) {
  test(team + ': grenade intel includes supplies, clusters and public flight data without hidden targets', () => {
    const game = quietGame(team);
    const [bot, mate] = bots(game);
    bot.grenades = 1;
    Object.assign(mate, { x: 42, y: 46 });
    humans(game).slice(0, 2).forEach((u, i) => Object.assign(u, { x: 40 + i * 2, y: 36 }));
    bot.visible = humans(game).slice(0, 2);
    const thrower = humans(game)[0];
    thrower.grenades = 1;
    assert(throwGrenade(game, thrower, { x: 44, y: 46 }));
    const snapshot = parseOpponentSnapshot(opponentSnapshot(game));
    assert.equal(snapshot.squad[0].grenadesLeft, 1);
    assert.equal(snapshot.squad[0].alliesWithinBlastRadius, 1);
    assert.deepEqual(snapshot.squad[0].grenadeOpportunity, { position: { x: 41, y: 36 }, enemiesCaught: 2 });
    assert.deepEqual(snapshot.grenades, [{ id: game.grenades[0].id, team: otherTeam(team),
      position: { x: 40, y: 36 }, landed: false, secondsToExplosion: null }]);
    const bomb = landed(game);
    assert.equal(opponentSnapshot(game).squad[0].dodgingGrenadeId, bomb.id);
    bot.grenades = 0;
    assert.equal(opponentSnapshot(game).squad[0].grenadeOpportunity, null);
  });

  for (const transport of ['gateway', 'direct']) test(team + ': ' + transport + ' sends grenade strategy and sanitized state', async () => {
    const game = quietGame(team);
    landed(game);
    const snapshot = opponentSnapshot(game);
    snapshot.grenades[0].hiddenLandingTarget = { x: 1, y: 1 };
    let instructions, input;
    const expected = mockOpponentPlan(snapshot);
    const options = transport === 'gateway' ? {
      env: { AI_GATEWAY_API_KEY: 'test-only' },
      generate: async settings => { instructions = settings.system; input = JSON.parse(settings.prompt); return { output: expected }; },
    } : {
      env: { OPENAI_API_KEY: 'test-only' },
      request: async (_url, options) => {
        const body = JSON.parse(options.body);
        instructions = body.instructions; input = JSON.parse(body.input);
        return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(expected) }] }] });
      },
    };
    assert.deepEqual((await createOpponentPlan(snapshot, options)).plan, expected);
    assert.match(instructions, new RegExp(team === 'attack' ? 'ATTACKER' : 'DEFENDER'));
    assert.match(instructions, /never hurts the thrower's team/);
    assert.match(instructions, /immediate reflexes override every order/);
    assert.equal(input.squad[0].dodgingGrenadeId, snapshot.grenades[0].id);
    assert.equal(input.grenades[0].secondsToExplosion, GRENADE.fuse);
    assert(!JSON.stringify(input).includes('hiddenLandingTarget'));
  });

  test(team + ': bot dodges while OpenAI is pending, keeps clear through a late order, then resumes', async () => {
    const game = quietGame(team);
    const bot = bots(game)[0];
    const hold = { x: bot.x, y: bot.y };
    let resolve, calls = 0;
    const commander = createOpponentCommander({ now: () => 0, request: () => {
      calls++;
      return new Promise(r => { resolve = r; });
    } });
    const pending = commander.update(game);
    const bomb = landed(game, { x: 36 });
    step(game, 0.9);
    commander.update(game);
    assert.equal(calls, 1);
    assert.equal(game.botCommander.status, 'thinking');
    assert.equal(bot.botDodge.grenadeId, bomb.id);
    assert(dist(bot, bomb) > GRENADE.radius + 2, 'continues escaping beyond the initial danger check');
    assert.equal(opponentSnapshot(game).squad[0].dodgingGrenadeId, bomb.id, 'commander still knows it is dodging');
    resolve(response({ plan: { summary: 'Hold', orders: bots(game).map(u => ({ unitId: u.id, action: 'hold', zone: 'Attacker Spawn' })) }, model: 'test' }));
    await pending;
    const before = bot.x;
    step(game, 0.15);
    assert(bot.x > before, 'late hold order cannot reverse a dodge');
    step(game, GRENADE.fuse - 0.85); // let it actually go off, whatever the fuse is tuned to
    assert.equal(bot.hp, 100);
    assert.equal(bot.botDodge, null);
    const away = dist(bot, hold);
    step(game, 0.4);
    assert(dist(bot, hold) < away, 'returns to its original hold position after the blast');
    commander.reset();
  });
}

test('grenade input rejects malformed supplies, threats and duplicate IDs', () => {
  const game = quietGame();
  landed(game);
  const snapshot = opponentSnapshot(game);
  for (const mutate of [
    s => { s.squad[0].grenadesLeft = 2; },
    s => { s.squad[0].grenadesLeft = 0.5; },
    s => { s.squad[0].alliesWithinBlastRadius = s.squad.length; },
    s => { s.squad[0].grenadeOpportunity = { position: { x: 40, y: 46 }, enemiesCaught: 2 }; },
    s => { s.squad[0].dodgingGrenadeId = 99; },
    s => { s.grenades[0].team = s.team; },
    s => { s.grenades[0].position.x = NaN; },
    s => { s.grenades[0].secondsToExplosion = 9; },
    s => { s.grenades[0].landed = false; },
    s => { s.grenades.push(s.grenades[0]); },
  ]) {
    const invalid = structuredClone(snapshot);
    mutate(invalid);
    assert.throws(() => parseOpponentSnapshot(invalid), /Invalid opponent/);
  }
});

test('friendly grenades and nearby blasts behind walls do not interrupt orders', () => {
  const game = quietGame();
  const bot = bots(game)[0];
  landed(game, { team: bot.team });
  assert.equal(incomingGrenade(game, bot), null);
  step(game, 0.1);
  assert.equal(bot.botDodge, null);
  assert.equal(bot.moving, false);
  Object.assign(bot, { x: 12, y: 30 });
  landed(game, { x: 16, y: 30 }); // wall starts at x=14
  assert.equal(incomingGrenade(game, bot), null);
  assert.equal(opponentSnapshot(game).squad[0].dodgingGrenadeId, null);
});

test('grenade use and landings trigger one debounced replan without fuse-tick or friendly-blast spam', async () => {
  const game = quietGame();
  const bot = bots(game)[0];
  bot.grenades = 1;
  let now = 0;
  const sent = [];
  const commander = createOpponentCommander({ now: () => now, request: async (_url, options) => {
    sent.push(JSON.parse(options.body)); return response(answer(game));
  } });
  await commander.update(game);
  now = 1000;
  const friendly = landed(game, { team: bot.team });
  commander.update(game);
  now = 1400;
  commander.update(game);
  assert.equal(sent.length, 1);
  game.grenades = [];
  bot.grenades = 0;
  const hostile = landed(game);
  commander.update(game);
  now = 1900;
  commander.update(game);
  assert.equal(sent.length, 1, 'respects the two-second minimum');
  now = 2000;
  await commander.update(game);
  assert.equal(sent.length, 2);
  assert.match(game.botCommander.reason, /used a grenade/);
  assert.match(game.botCommander.reason, /bots dodging/);
  for (now = 2100; now < 3500; now += 100) {
    game.time += 0.1;
    commander.update(game);
  }
  game.grenades = [];
  now = 3800;
  commander.update(game);
  assert.equal(sent.length, 2, 'same grenade and its expiry do not cause repeat requests');
  assert.notEqual(friendly.id, hostile.id);
  commander.reset();
});

test('grenade events keep failure backoff, and bots still dodge without OpenAI', async () => {
  const game = quietGame();
  let now = 0, calls = 0;
  const commander = createOpponentCommander({ now: () => now, request: async () => { calls++; throw new Error('offline'); } });
  await commander.update(game);
  landed(game);
  now = 3000;
  commander.update(game);
  step(game, 0.5);
  assert(bots(game)[0].botDodge);
  assert.equal(calls, 1);
  assert.equal(game.botCommander.status, 'fallback');
  commander.reset();
});

for (const team of ['attack', 'defend']) test(team + ': dodge interrupts the spike interaction and the objective resumes afterward', () => {
  const game = quietGame(team);
  const bot = bots(game)[0];
  Object.assign(bot, { x: 67, y: 14 });
  const action = team === 'attack' ? 'plant' : 'retake';
  if (team === 'defend') Object.assign(game.spike, { state: 'planted', carrierId: null, site: 'B Site', x: 67, y: 14, timer: 35 });
  applyOpponentPlan(game, { orders: bots(game).map(u => ({ unitId: u.id, action, zone: 'B Site' })) });
  step(game, 0.8);
  const progress = team === 'attack' ? game.spike.progress : game.spike.defuse;
  assert(progress > 0, 'spike interaction has started');
  landed(game, { x: 67, y: 18 });
  step(game, 0.2);
  assert(bot.botDodge);
  assert(bot.moving);
  assert((team === 'attack' ? game.spike.progress : game.spike.defuse) < progress);
  assert.equal(bot.botOrder.action, action, 'survival does not discard the objective');
  step(game, GRENADE.fuse - 0.1);
  assert.equal(bot.botDodge, null);
  assert.equal(bot.hp, 100);
  const goal = team === 'attack' ? 'planted' : 'defused';
  for (let i = 0; i < 1000 && game.spike.state !== goal; i++) stepGame(game, 1 / 60);
  assert.equal(game.spike.state, goal, 'squad completes the objective after dodging');
});
