import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GRENADE, MAX_HP, aliveTeam, createGame, grenadeSpot, incomingGrenade, setOrder, stepGame, teamUnits, teamView, throwGrenade,
} from '../public/commander/sim.js';

const RADIUS = 6;
const FUSE = 1.5;
const step = (game, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepGame(game, 1 / 60);
};
// A quiet round: nobody shoots (an infinite reaction time), so only the grenade does anything.
function bench() {
  const game = createGame({ defenders: 'players' });
  for (const u of game.units) {
    u.x = 40;
    u.y = 50;
    u.action = 'hold';
    u.reaction = Infinity;
    setOrder(game, u, { type: 'hold', zone: 'Attacker Spawn', point: { x: u.x, y: u.y } });
  }
  return game;
}
function place(game, team, spots) {
  teamUnits(game, team).forEach((u, i) => {
    const at = spots[i] ?? spots.at(-1);
    Object.assign(u, { x: at.x, y: at.y });
    setOrder(game, u, { type: 'hold', zone: 'Mid', point: { x: at.x, y: at.y } });
  });
}

test('a grenade hurts everyone standing together, hardest at the centre', () => {
  const game = bench();
  place(game, 'defend', [{ x: 40, y: 46 }, { x: 41.5, y: 46 }, { x: 44, y: 46 }, { x: 62, y: 46 }]);
  const thrower = teamUnits(game, 'attack')[0];
  Object.assign(thrower, { x: 40, y: 52 });
  assert.equal(throwGrenade(game, thrower, { x: 40, y: 46 }), true);
  assert.equal(thrower.grenades, 0, 'a thrown grenade is spent');
  step(game, 2.5);

  const [centre, near, edge, away] = teamUnits(game, 'defend');
  assert.ok(centre.hp === MAX_HP - GRENADE.centreDamage, `centre took the worst of it (hp ${centre.hp})`);
  assert.ok(near.hp > centre.hp && near.hp < MAX_HP, `1.5m away took less (hp ${near.hp})`);
  assert.ok(edge.hp > near.hp && edge.hp < MAX_HP, `4m away took least (hp ${edge.hp})`);
  assert.equal(away.hp, MAX_HP, 'someone 22m away is untouched');
});

test('the blast does not reach through walls, or hit your own squad', () => {
  const game = bench();
  const [mate] = teamUnits(game, 'attack');
  const [behindWall] = teamUnits(game, 'defend');
  // Mid is split from A Main by the block at x 14-32, y 21-44.
  Object.assign(behindWall, { x: 10, y: 30 });
  Object.assign(mate, { x: 34, y: 30 });
  const thrower = teamUnits(game, 'attack')[1];
  Object.assign(thrower, { x: 36, y: 30 });
  throwGrenade(game, thrower, { x: 33, y: 30 });
  step(game, 2.5);
  assert.equal(behindWall.hp, MAX_HP, 'a wall between you and the blast stops it');
  assert.equal(mate.hp, MAX_HP, 'your own squad is not hurt by your grenade');
});

test('a grenade goes as far as the arm reaches, on the bearing it was given', () => {
  const game = bench();
  const thrower = teamUnits(game, 'attack')[0];
  Object.assign(thrower, { x: 40, y: 52 });
  // Most of the map away. An arm has a limit, not a veto: it goes the full range that way
  // rather than being refused, which used to send the agent walking the throw in instead.
  assert.equal(throwGrenade(game, thrower, { x: 40, y: 5 }), true, 'a far spot is thrown at, not refused');
  const [nade] = game.grenades;
  assert.ok(nade.reach <= GRENADE.range + 0.01, `${nade.reach}m is past the arm`);
  assert.ok(Math.abs(nade.tx - thrower.x) < 0.01 && nade.ty < thrower.y, 'straight up the map, as pointed');
  assert.equal(thrower.grenades, 0, 'and it cost the grenade');
  assert.equal(throwGrenade(game, thrower, { x: 41, y: 46 }), false, 'only one carried');
});

test('a throw that would land underfoot is refused and costs nothing', () => {
  const game = bench();
  const thrower = teamUnits(game, 'attack')[0];
  // Pressed against the tall block between A Main and Mid, throwing into it: the lob has no
  // room to clear it, so the grenade would drop on the thrower. Better kept in hand.
  Object.assign(thrower, { x: 33, y: 30 });
  assert.equal(throwGrenade(game, thrower, { x: 10, y: 30 }), false);
  assert.equal(thrower.grenades, 1, 'a refused throw costs nothing');
  assert.equal(game.grenades.length, 0);
});

test('scattering gets an agent clear before the fuse runs out', () => {
  const game = bench();
  const [runner] = teamUnits(game, 'defend');
  Object.assign(runner, { x: 40, y: 46 });
  const thrower = teamUnits(game, 'attack')[0];
  Object.assign(thrower, { x: 40, y: 52 });
  throwGrenade(game, thrower, { x: 40, y: 46 });
  step(game, 0.4); // it has landed
  assert.ok(incomingGrenade(game, runner), 'the agent can tell one is about to go off');
  runner.action = 'scatter';
  step(game, FUSE + 0.4);
  assert.equal(runner.hp, MAX_HP, 'running the moment it lands escapes the blast');

  const game2 = bench();
  const [stayer] = teamUnits(game2, 'defend');
  Object.assign(stayer, { x: 40, y: 46 });
  const thrower2 = teamUnits(game2, 'attack')[0];
  Object.assign(thrower2, { x: 40, y: 52 });
  throwGrenade(game2, thrower2, { x: 40, y: 46 });
  step(game2, FUSE + 0.8);
  assert.ok(stayer.hp < MAX_HP / 2, `standing in it costs most of your health (hp ${stayer.hp})`);
});

test('the best spot is the one catching the most of a group, within range and sight', () => {
  const game = bench();
  place(game, 'defend', [{ x: 40, y: 46 }, { x: 41, y: 47 }, { x: 42, y: 45 }, { x: 64, y: 46 }]);
  const thrower = teamUnits(game, 'attack')[0];
  Object.assign(thrower, { x: 40, y: 52 });
  stepGame(game, 1 / 60); // work out who can see whom
  const spot = grenadeSpot(game, thrower);
  assert.equal(spot.caught, 3, 'the three standing together, not the loner');
  assert.ok(Math.hypot(spot.spot.x - 41, spot.spot.y - 46) < RADIUS, 'aimed at the middle of them');
});

test('an agent ordered to grenade a place throws it and then holds there', () => {
  const game = bench();
  const thrower = teamUnits(game, 'attack')[0];
  Object.assign(thrower, { x: 40, y: 52 });
  setOrder(game, thrower, { type: 'grenade', zone: 'Attacker Spawn', point: { x: 40, y: 46 } });
  thrower.action = 'advance';
  step(game, 1.5);
  assert.equal(thrower.grenades, 0, 'the order is carried out');
  assert.equal(thrower.order.type, 'hold', 'and it reverts to holding afterwards');
});

test('both sides can see a grenade in the air and on the ground', () => {
  const game = bench();
  const thrower = teamUnits(game, 'attack')[0];
  Object.assign(thrower, { x: 40, y: 52 });
  throwGrenade(game, thrower, { x: 40, y: 46 });
  for (const team of ['attack', 'defend']) {
    const view = teamView(game, team);
    assert.equal(view.grenades.length, 1, `${team} sees it`);
    assert.equal(view.grenades[0].team, 'attack');
  }
  step(game, 0.5);
  assert.equal(teamView(game, 'defend').grenades[0].landed, true, 'and sees when it lands');
  step(game, FUSE + 0.5);
  assert.equal(teamView(game, 'defend').grenades.length, 0, 'it is gone once it goes off');
});

test('defender bots throw at a group of attackers', () => {
  const game = createGame({ defenders: 'bots' });
  const bots = teamUnits(game, 'defend');
  for (const b of bots.slice(1)) b.alive = false; // one thrower, so the test is about its choice
  Object.assign(bots[0], { x: 34, y: 22 });
  aliveTeam(game, 'attack').forEach((u, i) => {
    Object.assign(u, { x: 33 + i, y: 30, reaction: Infinity }); // they don't shoot back
    setOrder(game, u, { type: 'hold', zone: 'Mid', point: { x: u.x, y: u.y } });
    u.action = 'hold';
  });
  step(game, 1.5);
  assert.equal(bots[0].grenades, 0, 'the bot used its grenade on the clump');
  step(game, 2);
  const hurt = teamUnits(game, 'attack').filter(u => u.hp < MAX_HP).length; // dead ones count too
  assert.ok(hurt >= 3, `a stacked squad all take damage (${hurt} hurt)`);
});
