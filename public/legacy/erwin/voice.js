// Push-to-talk voice orders: microphone → 16 kHz PCM → /api/voice (server relay) → Deepgram.
// Audio is only sent while talking; a short pre-roll catches the first syllable, and
// releasing the key sends Finalize so the full transcript comes back right away.
const PREROLL_CHUNKS = 3; // 300 ms

export function createVoice({ onInterim, onFinal, onStatus, onLevel }) {
  let ws = null;
  let ctx = null;
  let stream = null;
  let talking = false;
  let keyterms = [];
  let finals = [];
  let finalizeTimer = null;
  let keepAlive = null;
  const preroll = [];
  const counters = { chunks: 0, sent: 0, results: 0 };

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
      onStatus('Mic ready: hold V to talk', 'ok');
      return;
    }
    if (message.type !== 'Results') return;
    counters.results++;
    const transcript = message.channel?.alternatives?.[0]?.transcript ?? '';
    if (message.is_final) {
      if (transcript) finals.push(transcript);
      onInterim(finals.join(' '));
      if (message.from_finalize) dispatch();
    } else {
      onInterim([...finals, transcript].join(' '));
    }
  }

  function dispatch() {
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
    const text = finals.join(' ').trim();
    finals = [];
    if (text) onFinal(text);
  }

  function send(data) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(data);
    if (data instanceof ArrayBuffer) counters.sent++;
  }

  async function enable(terms) {
    keyterms = terms;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    const source = ctx.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(ctx, 'pcm-capture');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(capture).connect(mute).connect(ctx.destination);
    capture.port.onmessage = ({ data }) => {
      counters.chunks++;
      const pcm = new Int16Array(data);
      if (talking) {
        send(data);
        let sum = 0;
        for (let i = 0; i < pcm.length; i += 8) sum += (pcm[i] / 32768) ** 2;
        onLevel(Math.min(1, Math.sqrt(sum / (pcm.length / 8)) * 4));
      } else {
        preroll.push(data);
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
      }
    };
    keepAlive = setInterval(() => !talking && send(JSON.stringify({ type: 'KeepAlive' })), 4000);
    onStatus('Connecting to Deepgram…', 'pending');
    connect();
  }

  function setKeyterms(terms) {
    keyterms = terms;
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
      connect();
    }
  }

  function startTalking() {
    if (!stream || talking) return;
    talking = true;
    finals = [];
    for (const chunk of preroll.splice(0)) send(chunk);
    onInterim('');
  }

  function stopTalking() {
    if (!talking) return;
    talking = false;
    onLevel(0);
    send(JSON.stringify({ type: 'Finalize' }));
    finalizeTimer = setTimeout(dispatch, 1500); // in case the from_finalize result never arrives
  }

  function disable() {
    clearInterval(keepAlive);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    ctx?.close();
    const old = ws;
    ws = null;
    old?.close();
  }

  return {
    enable, disable, setKeyterms, startTalking, stopTalking,
    get enabled() { return Boolean(stream); },
    get debug() { return { audio: ctx?.state, socket: ws?.readyState, talking, ...counters }; },
  };
}
