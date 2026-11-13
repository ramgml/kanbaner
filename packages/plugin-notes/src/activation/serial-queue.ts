/**
 * Последовательная очередь одной активации плагина заметок.
 *
 * Не является глобальным singleton-ом: каждый `activate` получает собственную
 * очередь. Она сериализует доменные мутации, поисковые эффекты и полную
 * переиндексацию, чтобы reindex не прочитал документы до параллельной мутации
 * и не заменил индекс устаревшим снимком.
 */
export type SerialQueue = <Result>(operation: () => Promise<Result>) => Promise<Result>;

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  return <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const current = tail.then(operation, operation);

    tail = current.then(
      () => undefined,
      () => undefined,
    );

    return current;
  };
}
