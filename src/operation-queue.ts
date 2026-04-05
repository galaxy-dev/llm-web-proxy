// Async operation queue: serializes asynchronous operations so that only one runs at a time.
//
// Used by BrowserManager to prevent concurrent browser-interactive operations
// (page creation, clipboard paste, send button click) from interfering.
// Response-waiting phases run outside the queue, allowing true parallelism.
//
// Uses an explicit array queue (not a promise chain) to avoid memory leaks
// from ever-growing .then() chains in long-running processes.

export class OperationQueue {
  private running = false;
  private queue: Array<() => Promise<void>> = [];

  /** Enqueue an async operation; it will not start until all prior operations complete */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
      this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      await task();
    }
    this.running = false;
  }
}
