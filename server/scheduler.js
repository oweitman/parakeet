// One active inference. Pending partials for the same segment are replaced.
export class Scheduler {
  constructor(run, onError) { this.run = run; this.onError = onError; this.pending = new Map(); this.busy = false; }
  enqueue(owner, job) {
    const key = `${owner.id}:${job.segment}`;
    const previous = this.pending.get(key);
    let samples = job.pcm.length;
    for (const item of this.pending.values()) if (item.owner === owner && item !== previous) samples += item.job.pcm.length;
    if (samples > 45 * 16000) throw new Error('Backend overloaded: more than 45 seconds queued. Please try fewer users.');
    if (previous?.job.final) throw new Error('Segment already finalized');
    this.pending.set(key, { owner, job, queuedAt: performance.now() });
    void this.drain();
  }
  cancel(owner) { for (const [key, item] of this.pending) if (item.owner === owner) this.pending.delete(key); }
  has(owner) { return this.active?.owner === owner || [...this.pending.values()].some(item => item.owner === owner); }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.size) {
        const [key, item] = this.pending.entries().next().value;
        this.pending.delete(key); this.active = item;
        try {
          const queueMs = performance.now() - item.queuedAt;
          const audioSeconds = item.job.pcm.length / 16000;
          const result = await this.run(item.job.pcm);
          item.owner.result({ ...result, segment: item.job.segment, final: item.job.final,
            audioSeconds, queueMs });
        } catch (error) { this.onError(item.owner, error); }
        this.active = null; item.owner.idle?.();
      }
    } finally { this.active = null; this.busy = false; }
  }
}
