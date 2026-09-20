import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpponentPlan, parseOpponentSnapshot } from '../opponent.ts';
import { opponentSnapshot } from '../public/commander/opponent.js';
import { createCamera } from '../public/commander/pov.js';
import { castRay } from '../public/commander/world.js';
import {
  MANUAL_AIM, MAX_HP, RIFLE, createGame, crosshairTarget, manualAimFor, rifleAccuracy,
  setManualAim, setOrder, stepGame, teamView, throwGrenade,
} from '../public/commander/sim.js';

const STEP = 1 / 60;
function bench(t) {
  t.mock.method(Math, 'random', () => 0.5);
  const game = createGame({ defenders: 'players' });
  const shooter = game.units[0], target = game.units[4];
  for (const u of game.units) {
    Object.assign(u, { alive: u === shooter || u === target, reaction: Infinity, grenades: 0 });
  }
  const place = (u, x, y) => {
    Object.assign(u, { x, y, action: 'hold' });
    setOrder(game, u, { type: 'hold', zone: 'Top Hall', point: { x, y } });
  };
  shooter.reaction = 0;
  place(shooter, 10, 3);
  place(target, 20, 3);
  const aim = (patch = {}) => setManualAim(game, shooter.team, {
    unitId: shooter.id, yaw: 0, pitch: 0, ...patch,
  });
  const advance = seconds => {
    for (let i = 0; i < Math.ceil(seconds / STEP); i++) stepGame(game, STEP);
  };
  return { game, shooter, target, place, aim, advance };
}

test('both sides and difficulties share 150 HP and less accurate automatic rifles', () => {
  for (const opponent of ['scripted', 'openai']) for (const playerTeam of ['attack', 'defend']) {
    const game = createGame({ opponent, playerTeam });
    assert(game.units.every(u => u.hp === 150 && u.maxHp === 150));
    const u = { x: 0, y: 0, moving: false, stillSince: 0 };
    const target = { x: 20, y: 0, moving: false };
    game.time = 2;
    const stationary = rifleAccuracy(game, u, target);
    assert(stationary < 0.55 * (1 - 20 / 55) * 1.25);
    assert(stationary > rifleAccuracy(game, { ...u, moving: true }, target));
    assert(stationary > rifleAccuracy(game, u, { ...target, moving: true }));
    assert.equal(Math.ceil(MAX_HP / RIFLE.damage), 6);
  }
});

test('crosshair alignment improves automatic shooting without a fire input or extra cadence', t => {
  const { game, shooter, target, aim, advance } = bench(t);
  assert(aim());
  stepGame(game, STEP);
  assert.equal(target.hp, MAX_HP - RIFLE.damage);
  assert(teamView(game, shooter.team).units.find(u => u.id === shooter.id).aimHit);
  // Repeated input and releasing/reacquiring cannot bypass the rifle cooldown.
  for (let i = 0; i < 5; i++) {
    setManualAim(game, shooter.team, null);
    aim();
    stepGame(game, STEP);
  }
  assert.equal(target.hp, MAX_HP - RIFLE.damage);
  advance(RIFLE.interval);
  assert.equal(target.hp, MAX_HP - RIFLE.damage * 2);
  for (let i = 0; i < 4; i++) { aim(); advance(RIFLE.interval + STEP); }
  assert.equal(target.alive, false);
  assert(game.knownDown.attack.has(target.id));
});

test('crosshair changes the target and boosts only the aligned enemy, without bypassing reaction time', t => {
  const { game, shooter, target, place, aim, advance } = bench(t);
  place(target, 20, 5); // closer, but outside the crosshair
  const aligned = game.units[5]; aligned.alive = true; place(aligned, 25, 3);
  shooter.focusId = target.id;
  shooter.reaction = 0.3;
  aim(); stepGame(game, STEP);
  assert.equal(crosshairTarget(game, shooter), aligned);
  assert.equal(rifleAccuracy(game, shooter, aligned), MANUAL_AIM.accuracy);
  assert(rifleAccuracy(game, shooter, target) < MANUAL_AIM.accuracy);
  assert.equal(aligned.hp, MAX_HP, 'reaction time still applies');
  advance(0.3);
  assert.equal(shooter.targetId, aligned.id);
  assert.equal(aligned.hp, MAX_HP - RIFLE.damage);
  assert.equal(target.hp, MAX_HP);
  shooter.moving = true;
  assert.equal(rifleAccuracy(game, shooter, aligned), MANUAL_AIM.movingAccuracy);
});

for (const [label, patch] of [['sideways', { yaw: Math.PI / 2 }], ['above', { pitch: 0.2 }], ['below', { pitch: -0.3 }]]) {
  test(`aiming ${label} loses the bonus but keeps normal automatic shooting`, t => {
    const { game, shooter, target, aim } = bench(t);
    aim(patch);
    stepGame(game, STEP);
    assert.equal(target.hp, MAX_HP);
    assert.equal(crosshairTarget(game, shooter), null);
    assert.equal(shooter.targetId, target.id);
    assert(shooter.cooldown > 0, 'automatic fire continues off crosshair');
    assert.equal(game.effects.filter(e => e.kind === 'tracer').length, 1);
  });
}

test('crosshair targeting respects walls and range, and selects only the nearest aligned enemy', t => {
  const { game, shooter, target, place, aim } = bench(t);
  place(shooter, 10, 30);
  place(target, 34, 30); // solid wall x14..32
  aim(); stepGame(game, STEP);
  assert.equal(target.hp, MAX_HP);
  assert.equal(crosshairTarget(game, shooter), null);
  assert.equal(game.effects.filter(e => e.kind === 'tracer').length, 0, 'no shooting into walls or empty space');
  place(shooter, 10, 3); place(target, 70, 3);
  shooter.cooldown = 0;
  aim(); stepGame(game, STEP);
  assert.equal(target.hp, MAX_HP);
  place(target, 20, 3);
  const farther = game.units[5]; farther.alive = true; place(farther, 25, 3);
  shooter.cooldown = 0;
  aim(); stepGame(game, STEP);
  assert.equal(target.hp, MAX_HP - RIFLE.damage);
  assert.equal(farther.hp, MAX_HP);
});

test('aiming off target, switching agents and lease expiry never disable automatic fire', t => {
  const { game, shooter, target, aim, advance, place } = bench(t);
  shooter.reaction = 0;
  t.mock.method(Math, 'random', () => 0); // make normal automatic shots hit too
  aim({ yaw: Math.PI / 2 }); advance(0.2);
  assert.equal(target.hp, MAX_HP - RIFLE.damage);
  setManualAim(game, shooter.team, null); advance(RIFLE.interval);
  assert.equal(target.hp, MAX_HP - RIFLE.damage * 2);
  assert.equal(manualAimFor(game, shooter), null);
  const mate = game.units[1]; mate.alive = true; place(mate, 13, 3);
  aim();
  setManualAim(game, shooter.team, { unitId: mate.id, yaw: 0, pitch: 0 });
  assert.equal(manualAimFor(game, shooter), null);
  assert(manualAimFor(game, mate));
  advance(MANUAL_AIM.lease + STEP);
  assert.equal(manualAimFor(game, mate), null);
});

test('aim input rejects enemy/dead/bot control, malformed angles and ended rounds', t => {
  const { game, shooter, target, aim } = bench(t);
  for (const patch of [
    { unitId: target.id }, { unitId: 999 }, { unitId: '1' }, { yaw: NaN },
    { yaw: Infinity }, { pitch: -Infinity }, { pitch: MANUAL_AIM.maxPitch + 0.01 }, { pitch: '0' },
  ]) assert.equal(aim(patch), false);
  assert.equal(setManualAim(game, 'unknown', null), false);
  shooter.kind = 'bot'; assert.equal(aim(), false); shooter.kind = 'agent';
  shooter.alive = false; assert.equal(aim(), false); shooter.alive = true;
  assert(aim());
  game.result = { winner: 'attack' };
  assert.equal(aim(), false);
  assert.equal(manualAimFor(game, shooter), null);
});

test('crosshair assistance leaves order movement and grenade dodging running', t => {
  const { game, shooter, target, aim, advance } = bench(t);
  setOrder(game, shooter, { type: 'push', zone: 'Top Hall', point: { x: 15, y: 3 } });
  aim(); advance(0.3);
  assert(shooter.x > 11);
  target.grenades = 1;
  assert(throwGrenade(game, target, { x: shooter.x, y: shooter.y }));
  advance(0.6);
  shooter.action = 'scatter';
  const start = { x: shooter.x, y: shooter.y };
  aim(); advance(0.3);
  assert(Math.hypot(shooter.x - start.x, shooter.y - start.y) > 1);
  assert.equal(shooter.order.type, 'push');
});

test('manual camera follows the mouse immediately while spectator turns remain smoothed', () => {
  const camera = createCamera();
  const unit = { id: 1, x: 10, y: 3, facing: 0 };
  camera.update(unit, STEP);
  const aimed = camera.update(unit, STEP, { yaw: 1, pitch: 0.2 });
  assert.equal(aimed.angle, 1); assert.equal(aimed.pitch, 0.2);
  const released = camera.update(unit, STEP);
  assert(released.angle > 0 && released.angle < 1);
  assert.equal(released.pitch, 0);
  assert.equal(camera.update({ ...unit, id: 2, facing: -1 }, STEP).angle, -1);
});

test('shared wall rays handle parallel rays and report the closest wall', () => {
  const walls = [{ x: 14, y: 21, w: 18, h: 23 }];
  assert.equal(castRay(walls, 10, 30, 1, 0).t, 4);
  assert.equal(castRay(walls, 20, 15, 0, 1).t, 6);
  assert.equal(castRay(walls, 10, 3, 1, 0), null);
  assert.equal(castRay(walls, 10, 3, 0, 1), null);
});

for (const playerTeam of ['attack', 'defend']) test(`${playerTeam}: OpenAI accepts 150 HP and receives the new combat rules`, async () => {
  const snapshot = opponentSnapshot(createGame({ opponent: 'openai', playerTeam }));
  assert(parseOpponentSnapshot(snapshot).squad.every(u => u.hp === MAX_HP && u.maxHp === MAX_HP));
  const invalid = structuredClone(snapshot); invalid.squad[0].hp = MAX_HP + 1;
  assert.throws(() => parseOpponentSnapshot(invalid), /Invalid opponent/);
  await createOpponentPlan(snapshot, {
    env: { OPENAI_API_KEY: 'test-only' },
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.instructions, /150 HP/);
      assert.match(body.instructions, /6 hits to kill/);
      assert.match(body.instructions, /manually aim/);
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
        summary: 'Hold supporting angles', orders: snapshot.squad.map(u => ({ unitId: u.id, action: 'hold', zone: u.zone })),
      }) }] }] }) };
    },
  });
});
