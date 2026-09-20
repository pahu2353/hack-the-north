import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EASY_BOT, HARD_BOT, MANUAL_AIM, MAX_HP, RIFLE, createGame, grenadeSpot, rifleAccuracy,
  setOrder, stepGame, teamUnits, throwGrenade,
} from '../public/commander/sim.js';
import { applyOpponentPlan, opponentSnapshot } from '../public/commander/opponent.js';
import { parseOpponentSnapshot } from '../opponent.ts';
import { MAPS, dist, hasLineOfSight } from '../public/commander/world.js';

const step = (game, seconds) => {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) stepGame(game, 1 / 60);
};

test('only Hard bot opponents get extra health, accuracy and mobility, on both sides and maps', () => {
  for (const map of Object.keys(MAPS)) for (const playerTeam of ['attack', 'defend']) {
    for (const opponent of ['openai', 'scripted']) {
      const game = createGame({ map, playerTeam, opponent });
      for (const u of game.units) {
        const hard = u.kind === 'bot' && opponent === 'openai';
        assert.equal(u.hp, hard ? HARD_BOT.hp : u.kind === 'bot' ? EASY_BOT.hp : MAX_HP);
        assert.equal(u.maxHp, u.hp);
        if (hard) { assert.equal(u.speed, 5); assert.equal(u.reaction, 0.25); }
        Object.assign(u, { x: 10, y: 3, moving: false, stillSince: 0 });
        game.time = 2;
        const target = { x: 30, y: 3, moving: false };
        const probability = rifleAccuracy(game, u, target);
        assert.equal(probability, (hard ? HARD_BOT.accuracy : RIFLE.accuracy) * (1 - 20 / 55) * 1.25);
        assert(probability < MANUAL_AIM.accuracy);
        assert(rifleAccuracy(game, { ...u, moving: true }, target) < probability);
      }
    }
    const multiplayer = createGame({ map, defenders: 'players', opponent: 'openai' });
    assert(multiplayer.units.every(u => u.hp === MAX_HP));
    assert.equal(multiplayer.opponent, 'scripted');
  }
});

test('Hard health validation rejects invented maxima and health above the unit maximum', () => {
  const snapshot = opponentSnapshot(createGame({ opponent: 'openai' }));
  for (const [maxHp, hp] of [[999, 175], [175, 176], [150, 175], [NaN, 1]]) {
    const bad = structuredClone(snapshot);
    Object.assign(bad.squad[0], { maxHp, hp });
    assert.throws(() => parseOpponentSnapshot(bad), /Invalid opponent/);
  }
});

test('OpenAI accepts all ten grenades in a five-versus-five round', () => {
  const game = createGame({ opponent: 'openai' });
  for (const u of game.units) assert(throwGrenade(game, u, { x: u.x, y: u.y }));
  assert.equal(parseOpponentSnapshot(opponentSnapshot(game)).grenades.length, 10);
});

function hallway(opponent = 'openai', botTeam = 'defend') {
  const game = createGame({ opponent, playerTeam: botTeam === 'defend' ? 'attack' : 'defend' });
  const [bot, mate] = teamUnits(game, botTeam);
  const enemies = game.units.filter(u => u.team !== botTeam).slice(0, 2);
  for (const u of game.units) Object.assign(u, { alive: u === bot || u === mate || enemies.includes(u), reaction: Infinity, grenades: 0 });
  Object.assign(bot, { x: 14, y: 3, speed: 0 });
  Object.assign(mate, { x: 10, y: 3, speed: 0 });
  enemies.forEach((u, i) => {
    Object.assign(u, { x: 19 + i * 2, y: 3 });
    setOrder(game, u, { type: 'push', zone: 'Top Hall', point: { x: 65, y: 3 } });
  });
  applyOpponentPlan(game, { orders: [bot, mate].map(u => ({ unitId: u.id, action: 'hold', zone: 'Top Hall' })) });
  return { game, bot, mate, enemies };
}

for (const team of ['attack', 'defend']) test(`${team}: leading grenades hit a steadily moving pair that escapes Easy throws`, () => {
  const outcomes = [];
  for (const opponent of ['scripted', 'openai']) {
    const { game, bot, enemies } = hallway(opponent, team);
    bot.grenades = 1;
    stepGame(game, 1 / 60);
    if (opponent === 'openai') assert.equal(bot.grenades, 1, 'waits briefly to observe motion before throwing');
    step(game, 0.25);
    assert.equal(bot.grenades, 0);
    const grenade = game.grenades[0];
    assert(grenade);
    if (opponent === 'openai') {
      assert(grenade.tx > Math.max(...enemies.map(u => u.x)) + 6, 'leads through travel time and fuse');
    }
    step(game, 3.2);
    outcomes.push(enemies.filter(u => u.hp < u.maxHp).length);
  }
  assert.deepEqual(outcomes, [0, 2]);
});

test('grenade prediction uses observed motion, ignores hidden destinations, and stops at walls', () => {
  const { game, bot, enemies } = hallway();
  step(game, 0.3);
  const first = grenadeSpot(game, bot);
  assert(first.ready);
  for (const u of enemies) {
    u.path = [{ x: 1, y: 50 }];
    u.order.point = { x: 1, y: 50 }; // invisible future intent must not affect the prediction
  }
  assert.deepEqual(grenadeSpot(game, bot), first);

  // The same observed eastward motion aimed into a wall must stop before the wall.
  Object.assign(bot, { x: 8, y: 30 });
  enemies.forEach((u, i) => {
    Object.assign(u, { x: 10, y: 29 + i * 2 });
    game.intel[bot.team].set(u.id, { x: u.x, y: u.y, t: game.time, vx: 5, vy: 0, trackedFor: 1 });
  });
  bot.visible = enemies;
  const blocked = grenadeSpot(game, bot);
  assert(blocked);
  assert(blocked.spot.x < 14, 'does not predict movement through the wall at x=14');
  assert(hasLineOfSight(game.map, bot, blocked.spot));
});

test('stationary targets are not led, and lost or newly reacquired contacts do not retain a stale velocity', () => {
  const { game, bot, enemies } = hallway();
  step(game, 0.3);
  for (const u of enemies) {
    setOrder(game, u, { type: 'hold', zone: 'Top Hall', point: { x: u.x, y: u.y } });
  }
  step(game, 0.4);
  const stationary = grenadeSpot(game, bot);
  const center = enemies.reduce((sum, u) => sum + u.x, 0) / enemies.length;
  assert(Math.abs(stationary.spot.x - center) < 0.1);
  for (const u of enemies) {
    const seen = game.intel[bot.team].get(u.id);
    Object.assign(seen, { vx: 5, vy: 0 });
  }
  bot.visible = [];
  game.time += 0.5;
  const stale = grenadeSpot(game, bot);
  assert(Math.abs(stale.spot.x - center) < 0.1, 'lost contact stops extrapolating old movement');
  stepGame(game, 1 / 60);
  assert.equal(grenadeSpot(game, bot).ready, false, 'reacquiring requires fresh samples');
  assert(game.intel[bot.team].get(enemies[0].id).vx === 0);
});

test('Hard bots focus an exposed wounded enemy instead of the closest healthy one', () => {
  for (const opponent of ['scripted', 'openai']) {
    const { game, bot, mate, enemies } = hallway(opponent);
    for (const u of enemies) {
      setOrder(game, u, { type: 'hold', zone: 'Top Hall', point: { x: u.x, y: u.y } });
    }
    enemies[1].hp = 28;
    for (const u of [bot, mate]) u.reaction = 0;
    stepGame(game, 1 / 60);
    assert.equal(bot.targetId, opponent === 'openai' ? enemies[1].id : enemies[0].id);
  }
});

test('a supported Hard flanker continues under fire, but still takes emergency cover when isolated', () => {
  const { game, bot, mate, enemies } = hallway();
  bot.speed = HARD_BOT.speed;
  for (const u of enemies) setOrder(game, u, { type: 'hold', zone: 'Top Hall', point: { x: u.x, y: u.y } });
  applyOpponentPlan(game, { orders: [{ unitId: bot.id, action: 'flank', zone: 'B Site' }] });
  const start = { x: bot.x, y: bot.y };
  step(game, 0.5);
  assert(bot.visible.length === 2 && !bot.botFallback);
  assert(dist(bot, start) > 1, 'contact no longer freezes a flank');
  mate.alive = false;
  stepGame(game, 1 / 60);
  assert(bot.botFallback, 'survival still outranks the flank');
});

test('all five bots have distinct destination and retake staging positions on both maps', () => {
  for (const map of Object.keys(MAPS)) for (const playerTeam of ['attack', 'defend']) {
    const game = createGame({ opponent: 'openai', playerTeam, map });
    const squad = game.units.filter(u => u.kind === 'bot');
    const zone = game.map.sites[0];
    applyOpponentPlan(game, { orders: squad.map(u => ({ unitId: u.id, action: 'regroup', zone })) });
    assert.equal(new Set(squad.map(u => JSON.stringify(u.botOrder.point))).size, 5);
    if (game.botTeam === 'defend') {
      const site = game.map.zones.find(z => z.name === zone);
      Object.assign(game.spike, { state: 'planted', site: zone, x: site.center.x, y: site.center.y });
      applyOpponentPlan(game, { orders: squad.map(u => ({ unitId: u.id, action: 'retake', zone })) });
      assert.equal(new Set(Object.values(game.botRetake.spots).map(p => JSON.stringify(p))).size, 5);
    }
  }
});
