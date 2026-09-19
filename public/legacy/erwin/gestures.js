// Hand signals via MediaPipe's gesture recognizer (computer vision in the browser, on WASM).
// Pointing moves a cursor over the map; held gestures become orders that go to Jev.
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const HOLD_MS = 450; // a gesture must be held this long to count
const REPEAT_MS = 1800; // and can't re-fire sooner than this

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

export async function createGestures({ video, overlay, onPointer, onSignal, onStatus }) {
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
      onPointer(null, 'None');
      return;
    }
    draw.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, { color: '#4aa3ff', lineWidth: 3 });
    draw.drawLandmarks(hand, { color: '#ffd24a', radius: 3 });

    const top = result.gestures[0]?.[0];
    let name = top && top.score > 0.55 ? top.categoryName : 'None';
    if (name === 'None' && isPointing(hand)) name = 'Pointing_Up';
    // The preview is mirrored, so flip x to make pointing feel natural.
    onPointer(name === 'Pointing_Up' ? { x: 1 - hand[8].x, y: hand[8].y } : null, name);

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
