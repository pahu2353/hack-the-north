import assert from 'node:assert/strict';
import test from 'node:test';
import { aimFist, aimOrStep, pointDirection, repeatDelay, thumbDirection } from '../public/commander/gestures.js';

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

test('a held thumb steps faster the longer it is held, down to a floor', () => {
  const delays = [0, 1, 2, 3, 4, 5, 9].map(repeatDelay);
  assert.deepEqual(delays.slice(0, 4), [700, 590, 480, 370]);
  for (let i = 1; i < delays.length; i++) assert(delays[i] <= delays[i - 1], 'never slows down');
  assert.equal(Math.min(...delays), 260, 'and never runs away');
  // Four agents: holding through the whole squad takes well under two seconds.
  assert(delays.slice(0, 3).reduce((a, b) => a + b, 0) < 2000);
});

// Every finger curled in to the palm, thumb tucked: the first-person aiming pose.
function fistHand(degrees = 0) {
  const put = point => rotate(degrees, point);
  const hand = Array.from({ length: 21 }, () => put([0.03, -0.10]));
  hand[0] = put([0, 0]);
  hand[9] = put([0.01, -0.20]); // middle knuckle: the hand's scale
  hand[2] = put([-0.05, -0.10]);
  hand[3] = put([-0.06, -0.14]);
  hand[4] = put([-0.04, -0.15]); // thumb folded across, not sticking out
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    hand[pip] = put([0.03, -0.19]);
    hand[tip] = put([0.03, -0.11]); // tip curled back toward the wrist
  }
  return hand;
}

test('a fist aims the first-person view, whichever way the hand is turned', () => {
  for (const degrees of [0, 45, 90, -90, 160]) {
    assert(aimFist(fistHand(degrees)) > 0, `${degrees}\u00b0 is still a fist`);
  }
});

test('the shapes that used to steal the aim are not fists', () => {
  // A pointing finger was the old aiming pose; it kept flickering into the thumb and swipe
  // shapes and switching agents, so it must not be read as an aim now.
  assert.equal(aimFist(pointingHand(0)), 0);
  assert.equal(aimFist(pointingHand(90)), 0);
  // A thumb held out is how you step through the squad: it stays that, not an aim.
  assert.equal(aimFist(thumbHand(90)), 0);
  assert.equal(aimFist(thumbHand(-90)), 0);
  const open = fistHand(0);
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    open[pip] = { x: 0.5, y: 0.45 };
    open[tip] = { x: 0.5, y: 0.2 }; // fingers extended: an open palm
  }
  assert.equal(aimFist(open), 0);
});

test('a fist whose thumb creeps out still aims instead of switching agents', () => {
  const fist = fistHand(90); // held sideways, where a loose thumb reads as a left/right signal
  fist[4] = { x: fist[3].x - 0.02, y: fist[3].y - 0.02 };
  assert(aimFist(fist) > 0);
});

test('a thumb held out changes agent immediately, even straight after aiming', () => {
  // Mid-aim: the fist owns the hand.
  assert.deepEqual(aimOrStep(1, null, 0), { steering: true, thumb: null });
  // Tracking blinked and the fist was missed for a frame: the aim is not handed over.
  assert.deepEqual(aimOrStep(0, null, 120), { steering: true, thumb: null });
  // A clear thumb out wins at once, without waiting for the fist's grace period to run down.
  assert.deepEqual(aimOrStep(0, 'right', 0), { steering: false, thumb: 'right' });
  assert.deepEqual(aimOrStep(1, 'left', 0), { steering: false, thumb: 'left' });
  // Hand lowered long enough: back to normal, so swipes work again too.
  assert.deepEqual(aimOrStep(0, null, 900), { steering: false, thumb: null });
});
