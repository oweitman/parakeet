export const RATE = 16000;

// Demo energy gate; not a neural voice activity detector.
export class AudioSession {
  constructor(emit, { threshold = 0.008, interval = 1.5, silence = 0.8, maxSeconds = 12 } = {}) {
    this.emit = emit; this.threshold = threshold; this.interval = interval * RATE;
    this.silenceLimit = silence * RATE; this.maxSamples = maxSeconds * RATE;
    this.segment = 0; this.reset(); this.preRoll = []; this.preSamples = 0;
  }
  reset() { this.chunks = []; this.samples = 0; this.quiet = 0; this.lastEmit = 0; }
  push(pcm) {
    if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > RATE / 2) {
      throw new Error('Expected 1–8000 Float32 samples per audio message');
    }
    let energy = 0;
    for (const sample of pcm) {
      if (!Number.isFinite(sample) || Math.abs(sample) > 1.01) throw new Error('Invalid PCM sample');
      energy += sample * sample;
    }
    const speech = Math.sqrt(energy / pcm.length) >= this.threshold;
    if (!this.samples && !speech) {
      this.preRoll.push(pcm); this.preSamples += pcm.length;
      while (this.preSamples > RATE * 0.3 && this.preRoll.length > 1) this.preSamples -= this.preRoll.shift().length;
      return;
    }
    if (!this.samples) {
      this.segment++; this.chunks.push(...this.preRoll); this.samples = this.preSamples;
      this.preRoll = []; this.preSamples = 0;
    }
    this.chunks.push(pcm); this.samples += pcm.length;
    this.quiet = speech ? 0 : this.quiet + pcm.length;
    if (this.quiet >= this.silenceLimit || this.samples >= this.maxSamples) this.flush();
    else if (this.samples - this.lastEmit >= this.interval) this.publish(false);
  }
  publish(final) {
    const pcm = new Float32Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    this.lastEmit = this.samples;
    this.emit({ segment: this.segment, pcm, final });
  }
  flush() {
    if (this.samples) this.publish(true);
    this.reset(); this.preRoll = []; this.preSamples = 0;
  }
}
