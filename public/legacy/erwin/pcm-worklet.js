// Converts microphone audio (the AudioContext runs at 16 kHz) into 100 ms chunks of
// 16-bit PCM, which is what the Deepgram stream is configured for.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(1600);
    this.length = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      this.chunk[this.length++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.length === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(1600);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
