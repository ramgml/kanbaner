/**
 * FIFO-мьютекс для сериализации операций на одном соединении.
 *
 * Транзакция удерживает мьютекс до завершения async callback. Операции
 * других вызовов ждут и не выполняются внутри чужой транзакции.
 */
export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  /** Ждёт очередь и возвращает идемпотентную функцию освобождения. */
  async acquire(): Promise<() => void> {
    const previous = this.#tail;
    let releaseTail: () => void = () => undefined;

    this.#tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });

    await previous;

    let released = false;

    return () => {
      if (!released) {
        released = true;
        releaseTail();
      }
    };
  }

  /** Выполняет операцию, удерживая мьютекс. */
  async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();

    try {
      return await operation();
    } finally {
      release();
    }
  }
}
