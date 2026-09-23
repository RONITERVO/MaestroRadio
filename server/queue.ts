/** Wakeable waits keep cancellation immediate without polling the event loop. */
export class Pulse {
  private waiters = new Set<() => void>();
  notify() { for (const wake of [...this.waiters]) wake(); }
  wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

export class BoundedQueue<T> {
  private items: T[] = [];
  private closed = false;
  private pulse = new Pulse();
  constructor(private capacity: number) {}
  async space(signal: AbortSignal) {
    while (this.items.length >= this.capacity && !this.closed) await this.pulse.wait(signal);
    signal.throwIfAborted();
  }
  async put(item: T, signal: AbortSignal) {
    await this.space(signal);
    if (this.closed) throw new Error('Queue closed');
    this.items.push(item); this.pulse.notify();
  }
  async take(signal: AbortSignal): Promise<T | undefined> {
    while (!this.items.length && !this.closed) await this.pulse.wait(signal);
    signal.throwIfAborted();
    const item = this.items.shift(); this.pulse.notify(); return item;
  }
  close() { this.closed = true; this.pulse.notify(); }
}
