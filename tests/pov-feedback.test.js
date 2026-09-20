import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/commander/${name}`, import.meta.url), 'utf8');

// G switches renderer mid-round, so the two first-person views have to agree about what the
// player is being told. They drifted once already: pov3d drew its crosshair permanently green
// while pov only went green on a target, so the default view claimed the aim bonus was live
// even while you were looking at a wall. The sim publishes both fields on every snapshot
// (ownUnit in sim.js), and a renderer that ignores one is a renderer that lies about it.
test('both first-person renderers show whether the crosshair is on a target', () => {
  for (const name of ['pov.js', 'pov3d.js']) {
    const source = read(name);
    assert.match(source, /aimTargetId/, `${name} never reads aimTargetId, so its crosshair cannot change`);
    assert.match(source, /aimHit/, `${name} never reads aimHit, so an assisted hit is not confirmed`);
  }
});

// The sim is what makes the claim; if it stops publishing, the renderers above go quiet and the
// assertions there would still pass against two views that agree on nothing.
test('the snapshot still carries the aim feedback the renderers read', () => {
  const sim = read('sim.js');
  assert.match(sim, /aimTargetId: crosshairTarget\(/);
  assert.match(sim, /aimHit: game\.time - u\.lastAimHitAt/);
});
