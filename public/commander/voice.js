// Hands-free voice orders: microphone → 16 kHz PCM → /api/voice (server relay) → Deepgram.
// While listening, audio streams continuously and each spoken sentence becomes an order as
// soon as you pause (Deepgram's endpointing). While not listening (menus, muted), nothing is
// sent except keep-alives.
import { VOICE_THRESHOLDS, createVoiceMetrics, pcmRms } from './voice-metrics.js';

const PREROLL_CHUNKS = 3; // 300 ms catches the first syllable in hold-to-talk mode.

export function createVoice({ onInterim, onFinal, onStatus, onLevel }) {
  let ws = null;
  let ctx = null;
  let stream = null;
  let listening = false;
  let keyterms = [];
  let finals = [];
  let keepAlive = null;
  let capturing = false;
  const preroll = [];
  const counters = { chunks: 0, sent: 0, results: 0, orders: 0 };
  const metrics = createVoiceMetrics();

  function connect() {
    const params = new URLSearchParams();
    for (const term of keyterms) params.append('keyterm', term);
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice?${params}`);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => handleMessage(JSON.parse(event.data));
    socket.onclose = event => {
      if (ws !== socket) return;
      ws = null;
      onStatus(`Voice disconnected${event.reason ? `: ${event.reason}` : ''}`, 'error');
      if (stream) setTimeout(() => stream && !ws && connect(), 1500);
    };
    ws = socket;
  }

  function handleMessage(message) {
    if (message.type === 'Ready') {
      reportReady();
      return;
    }
    // Deepgram also sends UtteranceEnd after a longer silence, in case speech_final was missed.
    if (message.type === 'UtteranceEnd') {
      dispatch();
      return;
    }
    if (message.type !== 'Results') return;
    counters.results++;
    const transcript = message.channel?.alternatives?.[0]?.transcript ?? '';
    if (message.is_final) {
      if (transcript) finals.push(transcript);
      onInterim(finals.join(' '));
      if (message.speech_final || message.from_finalize) dispatch();
    } else if (transcript) {
      onInterim([...finals, transcript].join(' '));
    }
  }

  function dispatch() {
    const text = finals.join(' ').trim();
    finals = [];
    if (!text) return;
    if (capturing) metrics.stop();
    const voiceContext = metrics.finish(text);
    capturing = false;
    counters.orders++;
    onFinal(text, voiceContext);
  }

  function send(data) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(data);
    if (data instanceof ArrayBuffer) counters.sent++;
  }

  function reportReady() {
    if (ctx?.state === 'suspended') onStatus('Click anywhere to turn the mic on', 'pending');
    else onStatus(listening ? 'Listening' : 'Mic ready', 'ok');
  }

  async function enable(terms) {
    if (stream) return;
    keyterms = terms;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 });
    // Without a recent click (e.g. a guest whose match was started by the host), the browser
    // keeps audio suspended until the next interaction.
    if (ctx.state === 'suspended') {
      const resume = () => ctx?.resume();
      document.addEventListener('pointerdown', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
      ctx.onstatechange = reportReady;
    }
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    const source = ctx.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(ctx, 'pcm-capture');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(capture).connect(mute).connect(ctx.destination);
    capture.port.onmessage = ({ data }) => {
      counters.chunks++;
      if (!listening) {
        preroll.push(data);
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
        return;
      }
      send(data);
      const rms = pcmRms(data);
      // Begin at audible speech so idle mic time does not dilute this utterance's rate.
      if (!capturing && rms >= VOICE_THRESHOLDS.activityRms) {
        metrics.start();
        capturing = true;
      }
      if (capturing) metrics.sample(rms);
      onLevel(Math.min(1, rms * 4));
    };
    keepAlive = setInterval(() => !listening && send(JSON.stringify({ type: 'KeepAlive' })), 4000);
    onStatus('Connecting to Deepgram…', 'pending');
    connect();
  }

  function setListening(on) {
    if (on === listening || !stream) return;
    listening = on;
    if (!on) {
      send(JSON.stringify({ type: 'Finalize' })); // flush anything half-said
      onLevel(0);
    }
    if (ws?.readyState === WebSocket.OPEN) reportReady();
  }

  function setKeyterms(terms) {
    if (terms.join() === keyterms.join()) return;
    keyterms = terms;
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
      connect();
    }
  }

  function startTalking() {
    if (!stream || listening) return;
    finals = [];
    metrics.start();
    capturing = true;
    setListening(true);
    for (const chunk of preroll.splice(0)) send(chunk);
    onInterim('');
  }

  function stopTalking() {
    if (!listening) return;
    if (capturing) metrics.stop();
    capturing = false;
    setListening(false);
  }

  function disable() {
    listening = false;
    clearInterval(keepAlive);
    capturing = false;
    metrics.reset();
    preroll.length = 0;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    ctx?.close();
    ctx = null;
    const old = ws;
    ws = null;
    old?.close();
    onLevel(0);
  }

  return {
    enable, disable, setKeyterms, setListening, startTalking, stopTalking,
    get enabled() { return Boolean(stream); },
    get listening() { return listening; },
    get debug() { return { audio: ctx?.state, socket: ws?.readyState, listening, ...counters, ...metrics.debug }; },
  };
}
