import assert from 'node:assert/strict';
import test from 'node:test';
import { pointDirection } from '../public/commander/gestures.js';

// A canonical pointing hand relative to the wrist, in image coordinates (y grows downward),
// then rotated as a whole: pointing sideways turns the hand, it doesn't just move the fingertip.
const CANON = { wrist: [0, 0], mcp: [0, -0.20], pip: [0, -0.30], tip: [0, -0.46], curled: [0.05, -0.13] };

function hand(degrees) {
  const t = (degrees * Math.PI) / 180;
  const put = ([x, y]) => ({
    x: 0.5 + (x * Math.cos(t) - y * Math.sin(t)),
    y: 0.65 + (x * Math.sin(t) + y * Math.cos(t)),
  });
  const landmarks = Array.from({ length: 21 }, () => put(CANON.curled));
  landmarks[0] = put(CANON.wrist);
  landmarks[5] = put(CANON.mcp);
  landmarks[6] = put(CANON.pip);
  landmarks[8] = put(CANON.tip);
  return landmarks;
}

// The camera faces the person, so positive rotation (toward increasing image x) is their left.
test('only a finger pointing up aims at the map', () => {
  assert.equal(pointDirection(hand(0)), 'up');
  assert.equal(pointDirection(hand(25)), 'up');
  assert.equal(pointDirection(hand(-25)), 'up');
});

test('a sideways finger picks an agent, in the direction the person feels', () => {
  assert.equal(pointDirection(hand(-90)), 'right');
  assert.equal(pointDirection(hand(90)), 'left');
  assert.equal(pointDirection(hand(60)), 'left'); // diagonal, but mostly sideways
});

test('pointing down does nothing, and a fist is not pointing at all', () => {
  assert.equal(pointDirection(hand(180)), null);
  assert.equal(pointDirection(Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.62 }))), null);
});
