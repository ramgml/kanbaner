/**
 * Состояние области транзакции или savepoint.
 *
 * `active` сбрасывается сразу после завершения callback: новые операции
 * запрещены, а уже начатые должны завершиться до commit/rollback/release.
 * `rolledBack` фиксирует фактический откат области, а не только sealing.
 * `pending` хранит все начатые, но ещё не завершённые операции области.
 */
export interface TransactionScope {
  active: boolean;
  rolledBack: boolean;
  readonly parent: TransactionScope | null;
  readonly pending: Set<Promise<unknown>>;
}

export function createTransactionScope(parent: TransactionScope | null): TransactionScope {
  return { active: true, rolledBack: false, parent, pending: new Set<Promise<unknown>>() };
}

/** Проверяет активность области и всех её предков. */
export function isScopeActive(scope: TransactionScope): boolean {
  let current: TransactionScope | null = scope;

  while (current !== null) {
    if (!current.active) {
      return false;
    }

    current = current.parent;
  }

  return true;
}

/**
 * Проверяет, что предок уже фактически откатился.
 *
 * Sealed-предок ещё не означает rollback: родитель ждёт завершения tracked
 * child-областей. Вложенный rejected savepoint обязан восстановить собственный
 * snapshot при sealed-родителе и пропустить restore только после реального
 * rollback предка.
 */
export function hasRolledBackAncestor(scope: TransactionScope): boolean {
  let current: TransactionScope | null = scope;

  while (current !== null) {
    if (current.rolledBack) {
      return true;
    }

    current = current.parent;
  }

  return false;
}
