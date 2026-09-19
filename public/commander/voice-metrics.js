// Cheap observations of an utterance, not an emotion detector. RMS values are
// relative to the user's own speaking baseline because microphones vary widely.
export const VOICE_THRESHOLDS = {
  activityRms: 0.006,
  activityVsPeak: 0.2,
  baselineWeight: 0.2,
  baselineUpdateMin: 0.7,
  baselineUpdateMax: 1.3,
  quiet: 0.7,
  loud: 1.3,
  veryLoud: 1.8,
  slowWordsPerSecond: 1.6,
  fastWordsPerSecond: 3.2,
  minSpeechRateWords: 2,
  minSpeechRateDurationMs: 500,
  minPauseFrames: 2, // PCM chunks are 100 ms each.
  normalPauseFraction: 0.12,
  highPauseFraction: 0.35,
  lowEmphasisRatio: 1.35,
  highEmphasisRatio: 1.9,
  trendRatio: 1.35,
};

// Transcript words are a language cue, not a reliable measure of emotion.
// Match whole words so commands such as "pass" and "assault" do not count.
const STRONG_PROFANITY = new Set([
  'fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'fuckers', 'motherfucker', 'motherfuckers',
  'shit', 'shits', 'shitty', 'bullshit', 'bullshitting', 'bitch', 'bitches',
]);
const MILD_PROFANITY = new Set([
  'damn', 'dammit', 'goddamn', 'hell', 'crap', 'ass', 'bastard', 'piss',
]);

export function classifyProfanity(text) {
  let count = 0;
  let strong = false;
  for (const word of text.toLowerCase().match(/[\p{L}]+/gu) ?? []) {
    if (STRONG_PROFANITY.has(word)) { count++; strong = true; }
    else if (MILD_PROFANITY.has(word)) count++;
  }
  return { level: strong ? 'strong' : count ? 'mild' : 'none', count };
}

// The same sampled RMS used for the live level meter and utterance metrics.
export function pcmRms(data) {
  const pcm = new Int16Array(data);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 8) sum += (pcm[i] / 32768) ** 2;
  return Math.sqrt(sum / (pcm.length / 8));
}

export function classifyVolume(ratio) {
  if (ratio < VOICE_THRESHOLDS.quiet) return 'quiet';
  if (ratio < VOICE_THRESHOLDS.loud) return 'normal';
  if (ratio < VOICE_THRESHOLDS.veryLoud) return 'loud';
  return 'very_loud';
}

export function classifySpeechRate(wordsPerSecond, wordCount, durationMs) {
  if (wordCount < VOICE_THRESHOLDS.minSpeechRateWords || durationMs < VOICE_THRESHOLDS.minSpeechRateDurationMs) return 'normal';
  if (wordsPerSecond < VOICE_THRESHOLDS.slowWordsPerSecond) return 'slow';
  if (wordsPerSecond > VOICE_THRESHOLDS.fastWordsPerSecond) return 'fast';
  return 'normal';
}

export function classifyPauses(frames, activityThreshold) {
  const first = frames.findIndex(volume => volume >= activityThreshold);
  if (first < 0) return 'normal';
  let last = frames.length - 1;
  while (last > first && frames[last] < activityThreshold) last--;
  let run = 0;
  let pauseFrames = 0;
  for (let i = first; i <= last; i++) {
    if (frames[i] < activityThreshold) run++;
    else {
      if (run >= VOICE_THRESHOLDS.minPauseFrames) pauseFrames += run;
      run = 0;
    }
  }
  const fraction = pauseFrames / (last - first + 1);
  if (fraction >= VOICE_THRESHOLDS.highPauseFraction) return 'high';
  if (fraction >= VOICE_THRESHOLDS.normalPauseFraction) return 'normal';
  return 'low';
}

function classifyEmphasis(peak, average) {
  const ratio = peak / Math.max(average, VOICE_THRESHOLDS.activityRms);
  if (ratio < VOICE_THRESHOLDS.lowEmphasisRatio) return 'low';
  if (ratio >= VOICE_THRESHOLDS.highEmphasisRatio) return 'high';
  return 'normal';
}

function classifyTrend(frames) {
  if (frames.length < 6) return 'steady';
  const size = Math.floor(frames.length / 3);
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const first = average(frames.slice(0, size));
  const last = average(frames.slice(-size));
  if (first < VOICE_THRESHOLDS.activityRms || last < VOICE_THRESHOLDS.activityRms) return 'steady';
  if (last / first >= VOICE_THRESHOLDS.trendRatio) return 'rising';
  if (first / last >= VOICE_THRESHOLDS.trendRatio) return 'falling';
  return 'steady';
}

export function createVoiceMetrics() {
  let baselineVolume = null;
  let active = null;
  let latest = null;
  const pending = [];

  function start(at = performance.now()) {
    active = { startedAt: at, frames: [], sum: 0, peak: 0 };
  }

  function sample(rms) {
    if (!active) return;
    active.frames.push(rms);
    active.sum += rms;
    active.peak = Math.max(active.peak, rms);
  }

  function stop(at = performance.now()) {
    if (!active) return;
    pending.push({ ...active, durationMs: Math.max(1, at - active.startedAt) });
    active = null;
  }

  function finish(text) {
    const capture = pending.shift();
    if (!capture?.frames.length || !text?.trim()) return null;
    const { frames, peak, durationMs } = capture;
    const activityThreshold = Math.max(VOICE_THRESHOLDS.activityRms, peak * VOICE_THRESHOLDS.activityVsPeak);
    const speakingFrames = frames.filter(volume => volume >= activityThreshold);
    const averageVolume = speakingFrames.length
      ? speakingFrames.reduce((sum, volume) => sum + volume, 0) / speakingFrames.length
      : capture.sum / frames.length;
    const reference = baselineVolume ?? averageVolume;
    const volumeVsBaseline = reference > 0 ? averageVolume / reference : 1;
    const wordCount = text.trim().split(/\s+/).length;
    const wordsPerSecond = wordCount / (durationMs / 1000);
    const profanity = classifyProfanity(text);
    latest = {
      averageVolume,
      peakVolume: peak,
      sampleCount: frames.length,
      volumeVsBaseline,
      volumeLevel: classifyVolume(volumeVsBaseline),
      peakVolumeLevel: baselineVolume === null ? 'normal' : classifyVolume(reference > 0 ? peak / reference : 1),
      utteranceDurationMs: Math.round(durationMs),
      wordsPerSecond,
      speechRate: classifySpeechRate(wordsPerSecond, wordCount, durationMs),
      pauseLevel: classifyPauses(frames, activityThreshold),
      emphasisLevel: classifyEmphasis(peak, averageVolume),
      intensityTrend: classifyTrend(frames),
      profanityLevel: profanity.level,
      profanityCount: profanity.count,
    };

    // Update only from voiced frames, and cap each update so a shout cannot
    // immediately become the user's new normal speaking volume.
    if (speakingFrames.length >= 2 && averageVolume >= VOICE_THRESHOLDS.activityRms) {
      baselineVolume = baselineVolume === null ? averageVolume :
        baselineVolume * (1 - VOICE_THRESHOLDS.baselineWeight) +
        Math.min(
          baselineVolume * VOICE_THRESHOLDS.baselineUpdateMax,
          Math.max(baselineVolume * VOICE_THRESHOLDS.baselineUpdateMin, averageVolume),
        ) * VOICE_THRESHOLDS.baselineWeight;
    }
    return latest;
  }

  function reset() {
    active = null;
    pending.length = 0;
  }

  return {
    start, sample, stop, finish, reset,
    get debug() {
      return {
        baselineVolume,
        pendingUtterances: pending.length,
        latestAverageVolume: latest?.averageVolume ?? null,
        latestPeakVolume: latest?.peakVolume ?? null,
        latestVolumeVsBaseline: latest?.volumeVsBaseline ?? null,
        latestVolumeLevel: latest?.volumeLevel ?? null,
        latestUtteranceDurationMs: latest?.utteranceDurationMs ?? null,
        latestSpeechRate: latest?.speechRate ?? null,
        latestPauseLevel: latest?.pauseLevel ?? null,
        latestEmphasisLevel: latest?.emphasisLevel ?? null,
        latestProfanityLevel: latest?.profanityLevel ?? null,
        latest,
      };
    },
  };
}
