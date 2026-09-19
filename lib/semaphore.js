// lib/semaphore.js — a promise semaphore. `run(fn)` waits for a slot, runs fn, frees the slot.
// Used to cap how many model calls are in flight across every request at once.
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(Number(limit) || 1));
    this.active = 0;
    this.queue = [];
  }
  get waiting() { return this.queue.length; }
  acquire() {
    if (this.active < this.limit) { this.active++; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); // hand the slot straight over; active stays the same
    else this.active = Math.max(0, this.active - 1);
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}
module.exports = { Semaphore };
