import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOpponentSnapshot } from '../opponent.ts';
import { opponentSnapshot } from '../public/commander/opponent.js';
import {
  FLASH, SMOKE, blinded, createGame, relativePoint, setWeapon, stepGame, teamUnits, throwGrenade,
} from '../public/commander/sim.js';

const STEP = 1 / 30;
const run = (game, seconds) => {
  for (let f = 0; f < Math.round(seconds / STEP); f++) stepGame(game, STEP);
};

// A bot squad against human agents, with everyone parked except the two under test.
function botGame({ utility = true } = {}) {
  const game = createGame({ defenders: 'bots', opponent: 'openai', playerTeam: 'attack', utility });
  const bot = game.units.find(u => u.kind === 'bot');
  const human = teamUnits(game, 'attack')[0];
  for (const u of game.units) {
    u.reaction = Infinity;
    if (u !== bot && u !== human) Object.assign(u, { x: 2, y: 2, speed: 0 });
  }
  return { game, bot, human };
}

test('bots carry the kit only when the match has it', () => {
  const off = createGame({ defenders: 'bots', opponent: 'openai', utility: false });
  for (const u of off.units.filter(u => u.kind === 'bot')) {
    assert.equal(u.flashes, 0);
    assert.equal(u.smokes, 0);
  }
  const on = createGame({ defenders: 'bots', opponent: 'openai', utility: true });
  for (const u of on.units.filter(u => u.kind === 'bot')) {
    assert.equal(u.flashes, FLASH.carried);
    assert.equal(u.smokes, SMOKE.carried);
  }
});

test('a bot holding an angle at range pops its flash rather than sitting on it', () => {
  const { game, bot, human } = botGame();
  // Facing each other down Mid, far enough apart that a flash is worth throwing.
  Object.assign(bot, { x: 45, y: 26, facing: Math.PI / 2, speed: 0 });
  Object.assign(human, { x: 45, y: 42, facing: -Math.PI / 2, speed: 0 });
  run(game, 2.5);
  assert.equal(bot.flashes, 0, 'it used the flash');
  assert.ok(blinded(game, human) || human.glare > 0, 'and it went off where the human could see it');
});

test('a bot does not flash someone standing on top of it', () => {
  const { game, bot, human } = botGame();
  Object.assign(bot, { x: 45, y: 40, facing: Math.PI / 2, speed: 0 });
  Object.assign(human, { x: 45, y: 43, facing: -Math.PI / 2, speed: 0 });
  run(game, 2);
  assert.equal(bot.flashes, FLASH.carried, 'a flash in your own face is not a play');
});

test('bots never touch the kit in a match that does not have it', () => {
  const { game, bot, human } = botGame({ utility: false });
  Object.assign(bot, { x: 45, y: 26, facing: Math.PI / 2, speed: 0 });
  Object.assign(human, { x: 45, y: 42, facing: -Math.PI / 2, speed: 0 });
  run(game, 3);
  assert.equal(game.smokes.length, 0);
  assert.ok(game.grenades.every(g => (g.kind ?? 'frag') === 'frag'));
});

test('a bot behind someone who cannot see it takes the knife out and uses it', () => {
  const { game, bot, human } = botGame({ utility: false });
  // Directly behind the human, who is watching the other way.
  Object.assign(human, { x: 45, y: 40, facing: -Math.PI / 2, speed: 0, reaction: Infinity });
  Object.assign(bot, { x: 45, y: 43, facing: -Math.PI / 2, speed: 4.5 });
  run(game, 2);
  assert.equal(human.alive, false, 'from behind, that is the whole fight');
});

test('a bot in front of someone keeps its rifle', () => {
  const { game, bot, human } = botGame({ utility: false });
  Object.assign(human, { x: 45, y: 40, facing: Math.PI / 2, speed: 0 });
  Object.assign(bot, { x: 45, y: 43, facing: -Math.PI / 2, speed: 0 });
  run(game, 1);
  assert.equal(bot.weapon, 'rifle', 'you do not bring a knife to a gunfight you are already in');
});

test('the kit reaches the commander, and survives its own validator', () => {
  const { game, bot, human } = botGame();
  // Pinned, or the bot walks off the spot the throw was measured from.
  Object.assign(bot, { x: 45, y: 26, speed: 0 });
  Object.assign(human, { x: 45, y: 42, speed: 0 });
  assert.ok(throwGrenade(game, bot, { x: 45, y: 32 }, 'smoke'), 'the smoke goes out');
  run(game, 2);

  const raw = opponentSnapshot(game);
  assert.equal(raw.utility, true);
  assert.ok(raw.squad.every(u => u.flashesLeft !== undefined && u.smokesLeft !== undefined));
  assert.ok(raw.smokeClouds.length, 'the cloud is in the snapshot');

  // The validator rebuilds the snapshot from scratch, so anything it does not know about is
  // dropped before the model ever sees it.
  const parsed = parseOpponentSnapshot(raw);
  assert.equal(parsed.utility, true);
  assert.equal(parsed.squad[0].flashesLeft, FLASH.carried);
  assert.ok(parsed.smokeClouds.length, 'and it survives the rebuild');
});

test('a match without the kit sends the commander none of it', () => {
  const { game } = botGame({ utility: false });
  const parsed = parseOpponentSnapshot(opponentSnapshot(game));
  assert.equal(parsed.utility, undefined);
  assert.equal(parsed.smokeClouds, undefined);
  assert.equal(parsed.squad[0].flashesLeft, undefined);
});

test('a blinded bot is reported as blinded', () => {
  const { game, bot } = botGame();
  bot.blindUntil = game.time + 2;
  const parsed = parseOpponentSnapshot(opponentSnapshot(game));
  assert.equal(parsed.squad.find(u => u.id === bot.id).blinded, true);
  void setWeapon;
});

test('defenders cannot be sent to a spike nobody has planted', () => {
  const game = createGame({ defenders: 'players', playerTeam: 'attack' });
  const attacker = teamUnits(game, 'attack')[0];
  const defender = teamUnits(game, 'defend')[0];
  // Carried: only the attacking side knows where it is.
  assert.equal(game.spike.state, 'carried');
  assert.ok(relativePoint(game, attacker, 'spike'), 'their own carrier is no secret');
  assert.equal(relativePoint(game, defender, 'spike'), null, 'the carrier is not a place a defender knows');

  Object.assign(game.spike, { state: 'planted', x: 12, y: 14 });
  const at = relativePoint(game, defender, 'spike');
  assert.deepEqual({ x: at.x, y: at.y }, { x: 12, y: 14 }, 'once planted, everyone knows');
});
