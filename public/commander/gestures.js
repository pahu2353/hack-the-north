// Hand signals via MediaPipe's gesture recognizer (computer vision in the browser, on WASM).
// Pointing moves a cursor over the map; held gestures become orders that go to Jev.
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const SWIPE_DIST = 0.15;
const SWIPE_MS = 450;
const POINT_HOLD_MS = 260;
const POINT_REPEAT_MS = 700;
const POINT_REPEAT_MIN_MS = 260;
const POINT_REPEAT_STEP_MS = 110;
const PINCH_MS = 110;
const PINCH_CLOSED = 0.45;
const PINCH_OPEN = 0.6;
const MOTION_QUIET_MS = 700;
export const GESTURE_THRESHOLDS = {
  historyMs: 400,
  minRecognitionConfidence: 0.58,
  minAverageConfidence: 0.68,
  normalConfidence: 0.75,
  strongConfidence: 0.88,
  minStability: 0.75,
  strongStability: 0.9,
  detectedFrames: 2,
  stableFrames: 4,
  minContinuousMs: 165,
  fastConsecutiveFrames: 6,
  fastHoldMs: 220,
  normalHoldMs: 450,
  maxHoldMs: 550,
  releaseMs: 180,
  cooldownMs: 700,
  pointerSmoothing: 0.55,
  pointerMinConfidence: 0.3,
  pointerJumpThreshold: 0.2,
  pointerJumpConfirmDistance: 0.12,
  pointerJumpConfirmMs: 100,
  pointerGraceMs: 160,
  pointerContextMs: 800,
};

// A pointed map location remains available briefly after the camera loses tracking.
export const POINTER_ORDER_TTL_MS = 8000;
export const POINTER_ACTIVE_MS = 200;

export function cameraToMapPoint(point, map, margin = 0.15) {
  const scale = 1 - 2 * margin;
  const x = Math.min(1, Math.max(0, (point.x - margin) / scale));
  const y = Math.min(1, Math.max(0, (point.y - margin) / scale));
  return { x: x * map.width, y: y * map.height };
}

export const SIGNALS = {
  Thumb_Up: { emoji: '👍', label: 'Go', meaning: 'execute: everyone push to where I am pointing (or the current objective)' },
  Open_Palm: { emoji: '✋', label: 'Hold', meaning: 'everyone stop and hold your positions' },
  Closed_Fist: { emoji: '✊', label: 'Regroup', meaning: 'everyone group up together' },
  Thumb_Down: { emoji: '👎', label: 'Fall back', meaning: 'everyone retreat' },
  Victory: { emoji: '✌️', label: 'Split', meaning: 'split the squad into two pairs' },
  ILoveYou: { emoji: '🤟', label: 'Special', meaning: 'the special play' },
};

export function reliableGestureForSpeech(gesture) {
  return gesture?.context?.confidenceLevel === 'high' &&
    gesture.context.stabilityLevel === 'high';
}

// Hand landmark indices: 0 wrist, 5–8 index finger (8 = tip), 9–12 middle, 13–16 ring, 17–20 pinky.
function pointingConfidence(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  const extension = (tip, pip) => d(tip, 0) / Math.max(0.001, d(pip, 0));
  if (Math.max(extension(12, 10), extension(16, 14), extension(20, 18)) >= 1.15) return 0;
  return Math.min(1, Math.max(0, (extension(8, 6) - 1.15) / 0.3));
}

function isPointing(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  const extended = (tip, pip) => d(tip, 0) > d(pip, 0) * 1.15;
  return extended(8, 6) && !extended(12, 10) && !extended(16, 14) && !extended(20, 18);
}

// Pointing up aims at the map; a sideways thumb switches the watched agent.
export function pointDirection(hand) {
  if (!isPointing(hand)) return null;
  const dx = hand[5].x - hand[8].x;
  const dy = hand[5].y - hand[8].y;
  return Math.abs(dy) > Math.abs(dx) && dy > 0 ? 'up' : null;
}

export function thumbDirection(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  const extended = (tip, pip) => d(tip, 0) > d(pip, 0) * 1.15;
  if (!extended(4, 3)) return null;
  if (extended(8, 6) || extended(12, 10) || extended(16, 14) || extended(20, 18)) return null;
  const dx = hand[2].x - hand[4].x;
  const dy = hand[2].y - hand[4].y;
  if (Math.abs(dx) < Math.abs(dy) * 1.2) return null;
  return dx > 0 ? 'right' : 'left';
}

function pinchGap(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  return d(4, 8) / d(0, 9);
}

function pinchClosed(hand) {
  const d = (a, b) => Math.hypot(hand[a].x - hand[b].x, hand[a].y - hand[b].y);
  return pinchGap(hand) < PINCH_CLOSED && d(8, 0) > d(5, 0) * 1.1 && d(12, 0) > d(9, 0) * 1.1;
}

export function repeatDelay(steps) {
  return Math.max(POINT_REPEAT_MIN_MS, POINT_REPEAT_MS - steps * POINT_REPEAT_STEP_MS);
}

function holdDuration(confidence, stability, consecutive, runMs) {
  if (confidence >= GESTURE_THRESHOLDS.strongConfidence &&
    stability >= GESTURE_THRESHOLDS.strongStability &&
    consecutive >= GESTURE_THRESHOLDS.fastConsecutiveFrames &&
    runMs >= GESTURE_THRESHOLDS.fastHoldMs) {
    return GESTURE_THRESHOLDS.fastHoldMs;
  }
  return confidence >= GESTURE_THRESHOLDS.normalConfidence
    ? GESTURE_THRESHOLDS.normalHoldMs : GESTURE_THRESHOLDS.maxHoldMs;
}

// Several agreeing frames are required before a physical pose can become a command.
export function createGestureFilter() {
  const history = [];
  const lastFiredAt = {};
  let state = 'NONE';
  let candidate = null;
  let candidateSince = 0;
  let firedGesture = null;
  let releaseSince = null;
  let noneSince = null;
  let lastConfirmedGesture = null;
  const candidateMetrics = { stability: 0, averageConfidence: 0, heldMs: 0 };
  let debug = {};

  function update(name, confidence, now, { handPresent = name !== 'None', pointing = false } = {}) {
    const rawGesture = Object.hasOwn(SIGNALS, name) && confidence >= GESTURE_THRESHOLDS.minRecognitionConfidence ? name : 'None';
    history.push({ gestureName: rawGesture, confidence: rawGesture === 'None' ? 0 : confidence, timestamp: now });
    while (history.length && now - history[0].timestamp > GESTURE_THRESHOLDS.historyMs) history.shift();
    if (rawGesture === 'None') noneSince ??= now;
    else {
      if (noneSince !== null && now - noneSince >= GESTURE_THRESHOLDS.releaseMs &&
        state !== 'FIRED_WAITING_FOR_RELEASE') {
        history.length = 0;
        history.push({ gestureName: rawGesture, confidence, timestamp: now });
        state = 'NONE';
        candidate = null;
      }
      noneSince = null;
    }
    let feedback = { stage: 'none', name: null };
    let confirmed = null;
    let stability = 0;
    let averageConfidence = 0;
    let heldMs = 0;

    if (state === 'FIRED_WAITING_FOR_RELEASE') {
      // A weak classifier frame is not proof that the held hand was released.
      const released = !handPresent || pointing ||
        (name !== firedGesture && confidence >= GESTURE_THRESHOLDS.normalConfidence);
      if (!released) releaseSince = null;
      else releaseSince ??= now;
      if (releaseSince !== null && now - releaseSince >= GESTURE_THRESHOLDS.releaseMs) {
        state = 'NONE';
        firedGesture = null;
        candidate = null;
        releaseSince = null;
        history.length = 0;
        if (rawGesture !== 'None') history.push({ gestureName: rawGesture, confidence, timestamp: now });
      } else {
        feedback = { stage: 'confirmed', name: firedGesture };
        ({ stability, averageConfidence, heldMs } = candidateMetrics);
      }
    }

    if (state !== 'FIRED_WAITING_FOR_RELEASE' && rawGesture !== 'None') {
      let count = 0;
      let sum = 0;
      for (const frame of history) {
        if (frame.gestureName === rawGesture) { count++; sum += frame.confidence; }
      }
      let consecutive = 0;
      for (let i = history.length - 1; i >= 0 && history[i].gestureName === rawGesture; i--) consecutive++;
      const runMs = now - history[history.length - consecutive].timestamp;
      stability = count / history.length;
      averageConfidence = count ? sum / count : 0;
      if (count >= GESTURE_THRESHOLDS.detectedFrames) {
        const eligible = stability >= GESTURE_THRESHOLDS.minStability &&
          averageConfidence >= GESTURE_THRESHOLDS.minAverageConfidence;
        if (!eligible) { state = 'NONE'; candidate = null; }
        else {
          if (candidate !== rawGesture) {
            candidate = rawGesture;
            candidateSince = now;
          }
          state = 'CANDIDATE';
          heldMs = now - candidateSince;
          Object.assign(candidateMetrics, { stability, averageConfidence, heldMs });
        }
        const stable = eligible && count >= GESTURE_THRESHOLDS.stableFrames &&
          history.at(-2)?.gestureName === rawGesture;
        if (stability >= GESTURE_THRESHOLDS.minStability) {
          feedback = { stage: stable ? 'stabilizing' : 'detected', name: rawGesture };
        }
        if (stable && runMs >= GESTURE_THRESHOLDS.minContinuousMs &&
          heldMs >= holdDuration(averageConfidence, stability, consecutive, runMs) &&
          now - (lastFiredAt[rawGesture] ?? -Infinity) >= GESTURE_THRESHOLDS.cooldownMs) {
          state = 'FIRED_WAITING_FOR_RELEASE';
          firedGesture = rawGesture;
          lastFiredAt[rawGesture] = now;
          lastConfirmedGesture = rawGesture;
          confirmed = {
            name: rawGesture,
            meaning: SIGNALS[rawGesture].meaning,
            confidence: Math.round(averageConfidence * 100) / 100,
            confidenceLevel: averageConfidence >= GESTURE_THRESHOLDS.strongConfidence ? 'high'
              : averageConfidence >= GESTURE_THRESHOLDS.normalConfidence ? 'normal' : 'borderline',
            stability: Math.round(stability * 100) / 100,
            stabilityLevel: stability >= GESTURE_THRESHOLDS.strongStability ? 'high' : 'normal',
            heldMs: Math.round(heldMs),
          };
          feedback = { stage: 'confirmed', name: rawGesture };
        }
      }
    } else if (state !== 'FIRED_WAITING_FOR_RELEASE' && candidate) {
      const lastMatch = history.findLast(frame => frame.gestureName === candidate);
      if (lastMatch && now - lastMatch.timestamp < 100) feedback = { stage: 'stabilizing', name: candidate };
    }

    if (state === 'CANDIDATE' && feedback.stage === 'none') { state = 'NONE'; candidate = null; }
    if (rawGesture === 'None' && noneSince !== null && now - noneSince >= GESTURE_THRESHOLDS.releaseMs &&
      state !== 'FIRED_WAITING_FOR_RELEASE') {
      history.length = 0;
      state = 'NONE';
      candidate = null;
      feedback = { stage: 'none', name: null };
    }
    debug = {
      rawGesture: name, rawConfidence: confidence, filteredGesture: rawGesture,
      candidateGesture: candidate, stability, averageConfidence, heldMs: Math.round(heldMs),
      state, lastConfirmedGesture, historyFrames: history.length,
    };
    return { feedback, confirmed };
  }

  return { update, get debug() { return { ...debug }; } };
}

export function createPointerSmoother() {
  let raw = null;
  let smoothed = null;
  let pendingJump = null;
  let confidence = 0;
  let lastReliableAt = -Infinity;

  function update(point, score, now) {
    if (point && score >= GESTURE_THRESHOLDS.pointerMinConfidence) {
      raw = point;
      confidence = score;
      const recent = smoothed && now - lastReliableAt <= GESTURE_THRESHOLDS.pointerGraceMs;
      const jump = recent && Math.hypot(point.x - smoothed.x, point.y - smoothed.y) >
        GESTURE_THRESHOLDS.pointerJumpThreshold;
      if (jump) {
        const repeated = pendingJump && now - pendingJump.at <= GESTURE_THRESHOLDS.pointerJumpConfirmMs &&
          Math.hypot(point.x - pendingJump.point.x, point.y - pendingJump.point.y) <=
            GESTURE_THRESHOLDS.pointerJumpConfirmDistance;
        if (!repeated) {
          pendingJump = { point: { ...point }, at: now };
          return smoothed;
        }
        // A second nearby observation validates a large deliberate pointer move.
        smoothed = { ...point };
      } else if (recent) {
        smoothed.x += GESTURE_THRESHOLDS.pointerSmoothing * (point.x - smoothed.x);
        smoothed.y += GESTURE_THRESHOLDS.pointerSmoothing * (point.y - smoothed.y);
      } else smoothed = { ...point };
      pendingJump = null;
      lastReliableAt = now;
    } else {
      raw = null;
      confidence = 0;
      pendingJump = null;
    }
    return now - lastReliableAt <= GESTURE_THRESHOLDS.pointerGraceMs ? smoothed : null;
  }

  function recent(now) {
    const ageMs = now - lastReliableAt;
    return smoothed && ageMs <= GESTURE_THRESHOLDS.pointerContextMs
      ? { ...smoothed, active: ageMs <= GESTURE_THRESHOLDS.pointerGraceMs, ageMs: Math.round(ageMs) } : null;
  }

  return {
    update, recent,
    get debug() { return { rawX: raw?.x ?? null, rawY: raw?.y ?? null,
      smoothedX: smoothed?.x ?? null, smoothedY: smoothed?.y ?? null,
      confidence, lastReliableAt, pendingJump: pendingJump?.point ?? null }; },
  };
}

export async function createGestures({
  video, overlay, onPointer, onSignal, onFeedback, onSwipe, onPinch, onPointDirection, onStatus,
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

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    video.srcObject = null;
    recognizer.close();
    throw error;
  }
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  const canvasContext = overlay.getContext('2d');
  const draw = new DrawingUtils(canvasContext);
  onStatus('Camera on: point to aim, hold a sign to order', 'ok');

  const gestures = createGestureFilter();
  const pointer = createPointerSmoother();
  let lastFeedback = '';
  let lastVideoTime = -1;
  let running = true;
  let track = [];
  let quietUntil = 0;
  let pinchedSince = 0;
  let pinchArmed = true;
  let pointing = null;
  let pointingSince = 0;
  let pointingFiredAt = -Infinity;
  let pointingSteps = 0;

  function publishFeedback(feedback, smoothed) {
    const visible = feedback.stage === 'none' && smoothed
      ? { stage: 'pointing', name: 'Pointing_Up' } : feedback;
    const key = `${visible.stage}:${visible.name}`;
    if (key !== lastFeedback) {
      lastFeedback = key;
      onFeedback?.(visible);
    }
  }

  function motion(now) {
    quietUntil = now + MOTION_QUIET_MS;
    track = [];
    pinchedSince = 0;
    pointer.update(null, 0, now);
    onPointer(null);
    publishFeedback(gestures.update('None', 0, now, { handPresent: false }).feedback, null);
  }

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = recognizer.recognizeForVideo(video, now);
    canvasContext.clearRect(0, 0, overlay.width, overlay.height);
    const hand = result.landmarks[0];
    if (!hand) {
      track = [];
      pinchedSince = 0;
      pointing = null;
      onPointer(pointer.update(null, 0, now));
      publishFeedback(gestures.update('None', 0, now, { handPresent: false }).feedback, null);
      return;
    }
    draw.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, { color: '#4aa3ff', lineWidth: 3 });
    draw.drawLandmarks(hand, { color: '#ffd24a', radius: 3 });
    const top = result.gestures[0]?.[0];
    const score = top?.score ?? 0;
    const aiming = pointDirection(hand) === 'up';
    const thumb = thumbDirection(hand);
    let name = top?.categoryName ?? 'None';
    if (aiming) name = 'Pointing_Up';
    else if (thumb) name = thumb === 'right' ? 'Thumb_Right' : 'Thumb_Left';
    else if (name === 'Pointing_Up') name = 'None';

    // Navigation gestures keep their short local timing and never call Jev.
    if (thumb) {
      if (name !== pointing) {
        pointing = name;
        pointingSince = now;
        pointingFiredAt = -Infinity;
        pointingSteps = 0;
      }
      if (now - pointingSince > POINT_HOLD_MS &&
        now - pointingFiredAt > repeatDelay(pointingSteps) && now > quietUntil) {
        pointingFiredAt = now;
        pointingSteps++;
        onPointDirection?.(thumb === 'right' ? 1 : -1);
      }
    } else {
      pointing = null;
      pointingSteps = 0;
    }

    const palmX = 1 - (hand[0].x + hand[5].x + hand[17].x) / 3;
    track.push({ x: palmX, t: now });
    while (track.length && now - track[0].t > SWIPE_MS) track.shift();
    const travel = palmX - track[0].x;
    if (!aiming && !thumb && Math.abs(travel) > SWIPE_DIST && now > quietUntil) {
      motion(now);
      onSwipe?.(travel > 0 ? 1 : -1);
      return;
    }
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
    if (now < quietUntil) {
      onPointer(pointer.update(null, 0, now));
      publishFeedback(gestures.update('None', 0, now, { handPresent: false }).feedback, null);
      return;
    }

    const discreteName = Object.hasOwn(SIGNALS, name) && score >= GESTURE_THRESHOLDS.minRecognitionConfidence ? name : 'None';
    const pointScore = aiming && discreteName === 'None' ? pointingConfidence(hand) : 0;
    // Mirror the live pointer and smooth only its coordinates, not command recognition.
    const point = pointScore >= GESTURE_THRESHOLDS.pointerMinConfidence
      ? { x: 1 - hand[8].x, y: hand[8].y } : null;
    const smoothed = pointer.update(point, pointScore, now);
    onPointer(smoothed);
    const { feedback, confirmed } = gestures.update(name, score, now, {
      handPresent: true, pointing: Boolean(aiming || thumb),
    });
    publishFeedback(feedback, smoothed);
    if (confirmed) onSignal({ ...confirmed, pointer: pointer.recent(now) });
  }
  frame();

  return {
    stop() {
      running = false;
      stream.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      recognizer.close();
    },
    get debug() { return { ...gestures.debug, pointer: pointer.debug }; },
  };
}
