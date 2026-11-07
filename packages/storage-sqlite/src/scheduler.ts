import { AsyncLocalStorage } from "node:async_hooks";

import { sqliteError } from "./errors.ts";
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
 * Структурированная ошибка вместо вечного ожидания в FIFO.
 *
 * Вызов сделан из callback-а текущего владельца, но target scope является
 * предком или sibling-ом этого владельца. Такой вызов мог бы завершиться
 * только после возврата из callback-а, который его await-ит.
 */
function schedulingDeadlock(kind: OwnerKind) {
  return sqliteError(
    "INVALID_ARGUMENT",
    "Операция не может ждать собственный savepoint: обнаружен deadlock планировщика",
    { details: { reason: "SCHEDULING_DEADLOCK", operation: kind } },
  );
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
  #parent: TransactionScheduler | null = null;

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

    if (this.#ownerKind === "savepoint" && this.#ownerScope !== null) {
      // Операция внутри активного savepoint-а выполняется во вложенном
      // планировщике: parent/sibling по-прежнему ждут savepoint.
      if (isDescendantScope(scope, this.#ownerScope)) {
        if (this.#inner !== null) {
          return this.#inner.runOperation(scope, operation);
        }
      } else if (this.#isWithinOwner(current)) {
        return Promise.reject(schedulingDeadlock("operation"));
      }
    }

    return this.#acquire("operation", scope, operation);
  }

  runSavepoint<T>(scope: TransactionScope, callback: () => Promise<T> | T): Promise<T> {
    const current = executionContext.getStore();

    if (this.#ownerKind === "savepoint" && this.#ownerScope !== null) {
      // Вложенный savepoint внутри текущего savepoint callback-а получает
      // собственный вложенный планировщик. Sibling из callback-а родителя
      // сначала попадёт во вложенный планировщик, где и будет поставлен в
      // очередь либо отклонён как deadlock.
      if (isDescendantScope(scope, this.#ownerScope)) {
        if (this.#inner !== null) {
          return this.#inner.runSavepoint(scope, callback);
        }
      } else if (this.#isWithinOwner(current)) {
        return Promise.reject(schedulingDeadlock("savepoint"));
      }
    }

    // Savepoint не может ждать завершения операции, из тела которой он
    // вызван: операция ждёт этот savepoint.
    if (this.#ownerKind === "operation" && this.#isWithinOwner(current)) {
      return Promise.reject(schedulingDeadlock("savepoint"));
    }

    return this.#acquire("savepoint", scope, callback);
  }

  /**
   * Проверяет, что текущий execution context принадлежит callback-у владельца
   * этого планировщика (включая вложенные savepoint-планировщики).
   */
  #isWithinOwner(current: ExecutionContext | undefined): boolean {
    if (current === undefined || this.#ownerToken === null) {
      return false;
    }

    if (current.scheduler === this) {
      return current.token === this.#ownerToken;
    }

    let scheduler: TransactionScheduler | null = current.scheduler.#parent;

    while (scheduler !== null) {
      if (scheduler === this) {
        return true;
      }

      scheduler = scheduler.#parent;
    }

    return false;
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

    if (this.#inner !== null) {
      this.#inner.#parent = this;
    }

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
