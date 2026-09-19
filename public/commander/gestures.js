// Hand signals via MediaPipe's gesture recognizer (computer vision in the browser, on WASM).
// Pointing moves a cursor over the map; held gestures become orders that go to Jev.
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const HOLD_MS = 320; // a gesture must be held this long to count
const REPEAT_MS = 1500; // and can't re-fire sooner than this
const SCORE = 0.45; // how sure MediaPipe has to be about a sign
// Swipe: the palm travels this far across the frame (0–1) within SWIPE_MS.
const SWIPE_DIST = 0.15;
const SWIPE_MS = 450;
// Pinch: thumb and index fingertip closing together, like zooming on a phone. It fires once
// when they meet and rearms when the hand opens again.
// Pointing sideways: held this long to switch agent, then repeats while you keep holding it.
const POINT_HOLD_MS = 300;
const POINT_REPEAT_MS = 900;
const PINCH_MS = 110; // fingertips have to stay together this long
const PINCH_CLOSED = 0.45; // gap counting as closed, relative to hand size
const PINCH_OPEN = 0.6; // and the gap that rearms it
// After a swipe or pinch, ignore held signs for a moment so the hand's follow-through
// doesn't also give an order (a swipe ends with an open palm).
const MOTION_QUIET_MS = 700;

export const SIGNALS = {
  Thumb_Up: { emoji: '👍', label: 'Go', meaning: 'execute: everyone push to where I am pointing (or the current objective)' },
  Open_Palm: { emoji: '✋', label: 'Hold', meaning: 'everyone stop and hold your positions' },
  Closed_Fist: { emoji: '✊', label: 'Regroup', meaning: 'everyone group up together' },
  Thumb_Down: { emoji: '👎', label: 'Fall back', meaning: 'everyone retreat' },
  Victory: { emoji: '✌️', label: 'Split', meaning: 'split the squad into two pairs' },
  ILoveYou: { emoji: '🤟', label: 'Special', meaning: 'the special play' },
};

// Hand landmark indices: 0 wrist, 5–8 index finger (8 = tip), 9–12 middle, 13–16 ring, 17–20 pinky.
function isPointing(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  const extended = (tip, pip) => d(tip, 0) > d(pip, 0) * 1.15;
  return extended(8, 6) && !extended(12, 10) && !extended(16, 14) && !extended(20, 18);
}

// Where the index finger points: straight up aims at the map, sideways picks an agent.
// The camera image is mirrored, so +x is the direction the person feels as their right.
export function pointDirection(hand) {
  if (!isPointing(hand)) return null;
  const dx = hand[5].x - hand[8].x; // mirrored: tip further right than the knuckle
  const dy = hand[5].y - hand[8].y; // image y grows downward, so up is positive
  if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? 'up' : null; // pointing down means nothing
  return dx > 0 ? 'right' : 'left';
}

// Thumb tip to index fingertip, relative to hand size (wrist to middle knuckle).
function pinchGap(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  return d(4, 8) / d(0, 9);
}

// A fist also puts the thumb near the index fingertip, so a pinch only counts when the
// fingers are still reaching out.
function pinchClosed(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  return pinchGap(hand) < PINCH_CLOSED && d(8, 0) > d(5, 0) * 1.1 && d(12, 0) > d(9, 0) * 1.1;
}

export async function createGestures({
  video, overlay, onPointer, onSignal, onSwipe, onPinch, onPointDirection, onStatus,
}) {
  onStatus('Loading hand tracking…', 'pending');
  const { FilesetResolver, GestureRecognizer, DrawingUtils } = await import(`${VISION}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const options = delegate => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
  });
  let recognizer;
  try {
    recognizer = await GestureRecognizer.createFromOptions(fileset, options('GPU'));
  } catch {
    recognizer = await GestureRecognizer.createFromOptions(fileset, options('CPU'));
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  const draw = new DrawingUtils(overlay.getContext('2d'));
  onStatus('Camera on: point to aim, hold a sign to order', 'ok');

  let current = 'None';
  let since = 0;
  let fired = false;
  const lastFired = {};
  let lastVideoTime = -1;
  let running = true;
  let track = []; // recent palm positions, for swipes
  let quietUntil = 0;
  let pinchedSince = 0;
  let pinchArmed = true;
  let pointing = null;
  let pointingSince = 0;
  let pointingFiredAt = -Infinity;

  function motion(now) {
    quietUntil = now + MOTION_QUIET_MS;
    track = [];
    pinchedSince = 0;
    current = 'None';
  }

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = recognizer.recognizeForVideo(video, now);
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const hand = result.landmarks[0];
    if (!hand) {
      current = 'None';
      track = [];
      pinchedSince = 0;
      pointing = null;
      onPointer(null, 'None');
      return;
    }
    draw.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, { color: '#4aa3ff', lineWidth: 3 });
    draw.drawLandmarks(hand, { color: '#ffd24a', radius: 3 });

    const top = result.gestures[0]?.[0];
    let name = top && top.score > SCORE ? top.categoryName : 'None';
    // Our own reading of the finger wins: MediaPipe calls any point "Pointing_Up", but only a
    // finger that really points up aims, and a sideways one switches agents.
    const direction = pointDirection(hand);
    if (direction) name = { up: 'Pointing_Up', left: 'Point_Left', right: 'Point_Right' }[direction];
    else if (name === 'Pointing_Up') name = 'None';
    // The preview is mirrored, so flip x to make pointing feel natural.
    onPointer(name === 'Pointing_Up' ? { x: 1 - hand[8].x, y: hand[8].y } : null, name);

    // Point sideways to step through the squad; keep holding to keep stepping.
    if (name === 'Point_Left' || name === 'Point_Right') {
      if (name !== pointing) {
        pointing = name;
        pointingSince = now;
        pointingFiredAt = -Infinity;
      }
      if (now - pointingSince > POINT_HOLD_MS && now - pointingFiredAt > POINT_REPEAT_MS && now > quietUntil) {
        pointingFiredAt = now;
        onPointDirection?.(name === 'Point_Right' ? 1 : -1);
      }
    } else {
      pointing = null;
    }

    // Swipe: palm centre moving fast sideways (not while aiming). Mirrored x, so moving
    // your hand to your right is +1.
    const palmX = 1 - (hand[0].x + hand[5].x + hand[17].x) / 3;
    track.push({ x: palmX, t: now });
    while (track.length && now - track[0].t > SWIPE_MS) track.shift();
    const travel = palmX - track[0].x;
    if (!direction && Math.abs(travel) > SWIPE_DIST && now > quietUntil) {
      motion(now);
      onSwipe?.(travel > 0 ? 1 : -1);
      return;
    }

    // Pinch: fingertips together for a moment. Opening the hand rearms it.
    if (pinchClosed(hand)) {
      pinchedSince ||= now;
      if (pinchArmed && now - pinchedSince >= PINCH_MS && now > quietUntil) {
        pinchArmed = false;
        motion(now);
        onPinch?.();
        return;
      }
    } else {
      pinchedSince = 0;
      if (pinchGap(hand) > PINCH_OPEN) pinchArmed = true;
    }
    if (now < quietUntil) return;
    // A moving hand isn't holding a sign.
    if (Math.abs(travel) > 0.12) since = now;

    if (name !== current) {
      current = name;
      since = now;
      fired = false;
    } else if (!fired && SIGNALS[name] && now - since > HOLD_MS && now - (lastFired[name] ?? 0) > REPEAT_MS) {
      fired = true;
      lastFired[name] = now;
      onSignal(name);
    }
  }
  frame();

  return {
    stop() {
      running = false;
      stream.getTracks().forEach(track => track.stop());
      recognizer.close();
    },
  };
}
