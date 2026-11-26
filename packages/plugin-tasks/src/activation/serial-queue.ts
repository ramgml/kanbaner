/**
 * Последовательная очередь одной активации плагина.
 *
 * Не является глобальным singleton-ом: каждый `activate` получает собственную
 * очередь. Она сериализует мутации задач и полную переиндексацию поиска, чтобы
 * reindex не прочитал документы до параллельной мутации и не заменил индекс без
 * её результата.
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
