import { AsyncLocalStorage } from "node:async_hooks";

import type { TransactionScope } from "./scope.ts";

interface ExecutionContext {
  readonly scheduler: TransactionScheduler;
  readonly token: object;
}

/**
 * Текущая исполняемая область (операция или savepoint callback).
 *
 * AsyncLocalStorage отличает вызов из тела уже работающей операции от
 * параллельного вызова из callback-а транзакции с тем же scope.
 */
const executionContext = new AsyncLocalStorage<ExecutionContext>();

type OwnerKind = "operation" | "savepoint";

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
 * Stack-aware планировщик SQL-операций внутри одной транзакции.
 *
 * Обычная Store-операция выполняется немедленно только из собственного
 * исполняемого callback-а. Все параллельные операции, parent- и sibling-
 * вызовы ждут в FIFO.
 *
 * Savepoint push делает child-область владельцем: parent/sibling операции
 * ждут `RELEASE`/`ROLLBACK`, после чего восстанавливается предыдущий
 * владелец. Вложенный savepoint внутри текущего savepoint callback-а
 * получает собственный вложенный планировщик, поэтому sibling savepoints
 * сериализуются и не могут завершиться не по порядку.
 */
export class TransactionScheduler {
  #tail: Promise<void> = Promise.resolve();
  #ownerToken: object | null = null;
  #ownerScope: TransactionScope | null = null;
  #ownerKind: OwnerKind | null = null;
  #inner: TransactionScheduler | null = null;

  runOperation<T>(scope: TransactionScope, operation: () => Promise<T> | T): Promise<T> {
    const current = executionContext.getStore();

    // Реентерабельность разрешена только из тела этой же операции. Вызов из
    // callback-а транзакции с тем же scope сюда не попадает.
    if (
      this.#ownerKind === "operation" &&
      this.#ownerToken !== null &&
      current?.scheduler === this &&
      current.token === this.#ownerToken
    ) {
      return Promise.resolve().then(operation);
    }

    // Операция внутри активного savepoint-а выполняется во вложенном
    // планировщике: parent/sibling по-прежнему ждут savepoint.
    if (
      this.#ownerKind === "savepoint" &&
      this.#ownerScope !== null &&
      this.#inner !== null &&
      isDescendantScope(scope, this.#ownerScope)
    ) {
      return this.#inner.runOperation(scope, operation);
    }

    return this.#acquire("operation", scope, operation);
  }

  runSavepoint<T>(scope: TransactionScope, callback: () => Promise<T> | T): Promise<T> {
    const current = executionContext.getStore();

    // Вложенный savepoint разрешён только из callback-а текущего savepoint-а.
    // Sibling из callback-а родителя и savepoint во время обычной операции
    // ждут освобождения текущего владельца.
    if (
      this.#ownerKind === "savepoint" &&
      this.#ownerScope !== null &&
      this.#inner !== null &&
      current?.scheduler === this &&
      current.token === this.#ownerToken &&
      isDescendantScope(scope, this.#ownerScope)
    ) {
      return this.#inner.runSavepoint(scope, callback);
    }

    return this.#acquire("savepoint", scope, callback);
  }

  async #acquire<T>(
    kind: OwnerKind,
    scope: TransactionScope,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.#tail;
    let releaseTail: () => void = () => undefined;

    this.#tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });

    await previous;

    const previousToken = this.#ownerToken;
    const previousScope = this.#ownerScope;
    const previousKind = this.#ownerKind;
    const previousInner = this.#inner;
    const token = {};

    this.#ownerToken = token;
    this.#ownerScope = scope;
    this.#ownerKind = kind;
    this.#inner = kind === "savepoint" ? new TransactionScheduler() : null;

    try {
      return await executionContext.run({ scheduler: this, token }, async () => callback());
    } finally {
      this.#ownerToken = previousToken;
      this.#ownerScope = previousScope;
      this.#ownerKind = previousKind;
      this.#inner = previousInner;
      releaseTail();
    }
  }
}
