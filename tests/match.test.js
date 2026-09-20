import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREP_SECONDS, aliveTeam, createGame, createMatch, preparing, prepLine, roundStatus,
  scorecard, setOrder, stepGame, teamUnits, teamView,
} from '../public/commander/sim.js';
import { flipPoint, flippedFor } from '../public/commander/render.js';
import { MAPS, zoneByName } from '../public/commander/world.js';

const step = (game, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepGame(game, 1 / 60);
};
const map = MAPS.tactical;

test('the setup phase keeps both squads on their own side of the map', () => {
  const game = createGame({ defenders: 'players', prep: true });
  assert.equal(preparing(game), true);
  assert.equal(roundStatus(game, 'attack').label, 'Get into position');
  assert.equal(Math.round(roundStatus(game, 'attack').clock), PREP_SECONDS);
  // Everyone is ordered into the enemy half; nobody is allowed to get there yet.
  for (const u of game.units) {
    const site = zoneByName(map, u.team === 'attack' ? 'A Site' : 'Attacker Spawn');
    setOrder(game, u, { type: 'push', zone: site.name, point: site.center });
  }
  step(game, PREP_SECONDS - 1);
  for (const u of teamUnits(game, 'attack')) assert.ok(u.y >= prepLine(map, 'attack') - 0.01, `${u.name} stayed back (y ${u.y.toFixed(1)})`);
  for (const u of teamUnits(game, 'defend')) assert.ok(u.y <= prepLine(map, 'defend') + 0.01, `${u.name} stayed back (y ${u.y.toFixed(1)})`);
  assert.ok(game.units.every(u => u.hp === 100), 'and nobody can shoot across it');

  step(game, 2);
  assert.equal(preparing(game), false);
  assert.equal(teamView(game, 'attack').prep, null);
  assert.notEqual(roundStatus(game, 'attack').label, 'Get into position');
  step(game, 6);
  assert.ok(teamUnits(game, 'attack').some(u => u.y < prepLine(map, 'attack')), 'the line opens when the round goes live');
});

test('the round clock only starts once the setup phase ends', () => {
  const game = createGame({ defenders: 'players', prep: true });
  const before = roundStatus(game, 'defend');
  step(game, PREP_SECONDS + 0.1);
  assert.equal(before.prep, true);
  assert.equal(roundStatus(game, 'defend').prep, undefined);
  assert.ok(roundStatus(game, 'defend').clock > 99, 'a full round is still to play');
});

test('a planted spike wins the round even when every attacker is dead', () => {
  const game = createGame({ defenders: 'players' });
  Object.assign(game.spike, { state: 'planted', carrierId: null, site: 'B Site', x: 67, y: 14, timer: 30 });
  for (const u of teamUnits(game, 'attack')) u.alive = false;
  stepGame(game, 1 / 60);
  assert.equal(game.result.winner, 'attack');
  assert.match(game.result.reason, /Spike stands on B Site/);
  assert.equal(aliveTeam(game, 'attack').length, 0);
});

test('an unplanted spike is lost with the last attacker', () => {
  const game = createGame({ defenders: 'players' });
  for (const u of teamUnits(game, 'attack')) u.alive = false;
  stepGame(game, 1 / 60);
  assert.equal(game.result.winner, 'defend');
  assert.equal(game.result.reason, 'Attackers eliminated');
});

// One round, decided by wiping out the given team.
function playRound(match, loser) {
  const game = createGame({ defenders: 'players', match });
  const killer = teamUnits(game, loser === 'attack' ? 'defend' : 'attack')[0];
  for (const u of teamUnits(game, loser)) {
    u.alive = false;
    u.stats.deaths++;
    killer.stats.kills++;
    killer.stats.damage += 100;
  }
  stepGame(game, 1 / 60);
  return game;
}

test('a match is a best of three: the score and the scorecards carry across rounds', () => {
  const match = createMatch({ playerTeam: 'attack' });
  assert.deepEqual(match.score, { attack: 0, defend: 0 });
  assert.equal(match.needed, 2);

  const first = playRound(match, 'defend');
  assert.deepEqual(match.score, { attack: 1, defend: 0 });
  assert.equal(match.over, false);
  assert.equal(match.rounds.length, 1);
  assert.equal(first.match, match);
  const [star] = scorecard(match, 'attack');
  assert.equal(star.kills, 5);
  assert.equal(star.damage, 500);
  assert.equal(scorecard(match, 'defend').every(row => row.deaths === 1), true);

  playRound(match, 'attack'); // the defenders take one back
  assert.deepEqual(match.score, { attack: 1, defend: 1 });
  assert.equal(match.over, false);

  const decider = playRound(match, 'defend');
  assert.deepEqual(match.score, { attack: 2, defend: 1 });
  assert.equal(match.over, true);
  assert.equal(match.winner, 'attack');
  assert.equal(scorecard(match, 'attack')[0].kills, 10, 'totals add up over the whole match');
  assert.equal(decider.match.rounds.length, 3);

  // A finished round is folded in once, however many frames run afterwards.
  step(decider, 1);
  assert.deepEqual(match.score, { attack: 2, defend: 1 });
  assert.equal(match.rounds.length, 3);
});

test('a team view carries the score, the round number and both scorecards', () => {
  const match = createMatch({ playerTeam: 'defend' });
  playRound(match, 'attack');
  const game = createGame({ defenders: 'players', match, prep: true });
  teamUnits(game, 'defend')[0].stats.kills = 2;
  const view = teamView(game, 'defend');
  assert.equal(view.match.round, 2);
  assert.equal(view.match.bestOf, 3);
  assert.deepEqual(view.match.score, { attack: 0, defend: 1 });
  assert.equal(view.match.rounds[0].winner, 'defend');
  assert.equal(view.prep.line, prepLine(map, 'defend'));
  assert.equal(Math.round(view.prep.secondsLeft), PREP_SECONDS);
  // Last round's kills plus this round's, for both sides.
  assert.equal(view.match.scoreboard.defend[0].kills, 7);
  assert.equal(view.match.scoreboard.attack.length, 5);
  assert.equal(view.match.scoreboard.defend.every(row => 'alive' in row), true);
});

test('the defending commander sees the map the other way up', () => {
  assert.equal(flippedFor('defend'), true);
  assert.equal(flippedFor('attack'), false);
  // A spot marked at the top of a defender's screen is the attackers' half.
  assert.deepEqual(flipPoint(map, { x: 20, y: 6 }), { x: 60, y: 50 });
  assert.deepEqual(flipPoint(map, flipPoint(map, { x: 12, y: 14 })), { x: 12, y: 14 });
});
