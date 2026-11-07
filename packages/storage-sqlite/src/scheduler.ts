import type { TransactionScope } from "./scope.ts";

function isDescendantScope(scope: TransactionScope, ancestor: TransactionScope): boolean {
  let current: TransactionScope | null = scope;

  while (current !== null) {
    if (current === ancestor) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

/**
 * Планировщик операций внутри одной транзакции.
 *
 * Соединение уже монополизировано транзакцией, но async callback-и могут
 * перемешивать операции и savepoint-ы. Планировщик сериализует обычные
 * операции и делает savepoint-область эксклюзивной относительно parent- и
 * sibling-операций на всё время callback-а.
 *
 * Вложенный savepoint внутри уже удерживаемой области выполняется
 * реентерабельно: его scope является потомком текущего владельца. Sibling-
 * savepoint ждёт освобождения, поэтому SQL-stack не перемешивается.
 */
export class TransactionScheduler {
  #tail: Promise<void> = Promise.resolve();
  #heldBy: TransactionScope | null = null;

  async runExclusive<T>(scope: TransactionScope, operation: () => Promise<T> | T): Promise<T> {
    if (this.#heldBy !== null && isDescendantScope(scope, this.#heldBy)) {
      return operation();
    }

    const previous = this.#tail;
    let releaseTail: () => void = () => undefined;

    this.#tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });

    await previous;
    this.#heldBy = scope;

    try {
      return await operation();
    } finally {
      this.#heldBy = null;
      releaseTail();
    }
  }
}
