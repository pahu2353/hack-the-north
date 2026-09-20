import assert from 'node:assert/strict';
import test from 'node:test';
import { createGestureFilter, createPointerSmoother } from '../public/commander/gestures.js';

test('strong stable sign confirms within 300 ms and a held sign fires once', () => {
  const filter = createGestureFilter();
  const fired = [];
  for (let frame = 0; frame < 40; frame++) {
    const now = frame * 33;
    const result = filter.update('Thumb_Up', 0.95, now);
    if (result.confirmed) fired.push(now);
  }
  assert.equal(fired.length, 1);
  assert.ok(fired[0] >= 200 && fired[0] <= 300);

  for (let now = 1320; now <= 1551; now += 33) {
    assert.equal(filter.update('None', 0, now, { handPresent: false }).confirmed, null);
  }
  for (let frame = 0; frame < 18; frame++) {
    const now = 1584 + frame * 33;
    const result = filter.update('Thumb_Up', 0.95, now);
    if (result.confirmed) fired.push(now);
  }
  assert.equal(fired.length, 2, 'a release allows one later repeat');
});

test('brief, weak, and alternating recognitions do not issue commands', () => {
  const filter = createGestureFilter();
  const fired = [];
  for (let frame = 0; frame < 20; frame++) {
    const result = filter.update('Thumb_Up', 0.55, frame * 33);
    if (result.confirmed) fired.push(result.confirmed);
  }
  for (let frame = 20; frame < 40; frame++) {
    const result = filter.update(frame % 2 ? 'Thumb_Up' : 'Thumb_Down', 0.95, frame * 33);
    if (result.confirmed) fired.push(result.confirmed);
  }
  assert.deepEqual(fired, []);
});

test('pointer ignores one-frame jumps but accepts deliberate large moves next frame', () => {
  const pointer = createPointerSmoother();
  assert.deepEqual(pointer.update({ x: 0.2, y: 0.2 }, 0.9, 0), { x: 0.2, y: 0.2 });
  const slight = pointer.update({ x: 0.21, y: 0.19 }, 0.9, 33);
  assert.ok(Math.hypot(slight.x - 0.2, slight.y - 0.2) < 0.02);
  assert.deepEqual(pointer.update({ x: 0.9, y: 0.9 }, 0.9, 66), slight);
  const moved = pointer.update({ x: 0.91, y: 0.9 }, 0.9, 99);
  assert.ok(moved.x > 0.9 && moved.y >= 0.9);
});
