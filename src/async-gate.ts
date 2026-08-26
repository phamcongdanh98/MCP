export class AsyncGate {
  readonly #queue: Array<() => void> = [];
  #active = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('AsyncGate limit must be positive');
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  private release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#active -= 1;
  }
}
