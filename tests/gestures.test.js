import assert from 'node:assert/strict';
import test from 'node:test';
import { pointDirection, thumbDirection } from '../public/commander/gestures.js';

// Hands are built from a canonical pose relative to the wrist, in image coordinates (y grows
// downward), then rotated as a whole: pointing or thumbing sideways turns the hand, it does not
// just move one fingertip. The camera faces the person, so +rotation goes toward their left.
const rotate = (degrees, [x, y]) => {
  const t = (degrees * Math.PI) / 180;
  return { x: 0.5 + (x * Math.cos(t) - y * Math.sin(t)), y: 0.65 + (x * Math.sin(t) + y * Math.cos(t)) };
};

// Index finger out, everything else curled near the palm.
function pointingHand(degrees) {
  const put = point => rotate(degrees, point);
  const hand = Array.from({ length: 21 }, () => put([0.05, -0.13]));
  hand[0] = put([0, 0]);
  hand[5] = put([0, -0.20]);
  hand[6] = put([0, -0.30]);
  hand[8] = put([0, -0.46]);
  return hand;
}

// Thumb out, fingers curled. 0 degrees points the thumb straight up.
function thumbHand(degrees) {
  const put = point => rotate(degrees, point);
  const hand = Array.from({ length: 21 }, () => put([0.04, -0.12])); // curled fingers
  hand[0] = put([0, 0]);
  hand[2] = put([-0.06, -0.14]); // thumb knuckle
  hand[3] = put([-0.10, -0.22]);
  hand[4] = put([-0.14, -0.30]); // thumb tip
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    hand[pip] = put([0.05, -0.16]);
    hand[tip] = put([0.05, -0.11]); // tip nearer the wrist than the knuckle: curled
  }
  return hand;
}

test('only an index finger pointing up aims at the map', () => {
  assert.equal(pointDirection(pointingHand(0)), 'up');
  assert.equal(pointDirection(pointingHand(25)), 'up');
  assert.equal(pointDirection(pointingHand(-25)), 'up');
});

test('a finger held sideways or down no longer aims', () => {
  assert.equal(pointDirection(pointingHand(90)), null);
  assert.equal(pointDirection(pointingHand(-90)), null);
  assert.equal(pointDirection(pointingHand(180)), null);
});

test('a thumb held out sideways picks the agent on that side', () => {
  // +rotation swings the thumb toward increasing image x, which is the person's left, because
  // the camera faces them. The canonical thumb already leans, so horizontal is near ±90°.
  assert.equal(thumbDirection(thumbHand(90)), 'left');
  assert.equal(thumbDirection(thumbHand(120)), 'left');
  assert.equal(thumbDirection(thumbHand(-90)), 'right');
  assert.equal(thumbDirection(thumbHand(-60)), 'right');
});

test('an upright thumb is left alone, so thumbs up still means go', () => {
  assert.equal(thumbDirection(thumbHand(0)), null);
  assert.equal(thumbDirection(thumbHand(180)), null);
});

test('an open hand is not a thumb signal', () => {
  const open = thumbHand(120);
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    open[pip] = { x: 0.5, y: 0.45 };
    open[tip] = { x: 0.5, y: 0.25 }; // fingers extended away from the wrist
  }
  assert.equal(thumbDirection(open), null);
});
