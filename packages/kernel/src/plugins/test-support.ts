import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getFixtureRecords, resetFixtureRecords } from "./__fixtures__/records.ts";

export interface FixtureGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

const GATES_KEY = "__kanbanerKernelFixtureGates";
const FIXTURES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function gateStore(): Map<string, FixtureGate> {
  const holder = globalThis as unknown as Record<string, Map<string, FixtureGate> | undefined>;
  const existing = holder[GATES_KEY];

  if (existing !== undefined) {
    return existing;
  }

  const created = new Map<string, FixtureGate>();
  holder[GATES_KEY] = created;

  return created;
}

/** Абсолютный путь к каталогу fixture-сценария. */
export function fixturePath(...parts: string[]): string {
  return join(FIXTURES_DIRECTORY, ...parts);
}

/** Очищает журнал fixture-модулей и снимает незакрытые gate-ы между тестами. */
export function resetFixtures(): void {
  resetFixtureRecords();
  gateStore().clear();
}

/** События fixture-модулей в порядке выполнения. */
export function fixtureEvents(): readonly string[] {
  return getFixtureRecords();
}

/**
 * Создаёт gate, который fixture-модуль ждёт в activate/deactivate.
 *
 * Возвращает функцию освобождения. Gate нужно создать до запуска операции.
 */
export function createFixtureGate(name: string): () => void {
  let release: () => void = () => {
    // Заменяется синхронно ниже.
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  gateStore().set(name, { promise, release });

  return release;
}

/** Ждёт появления события fixture-модуля, не завися от планировщика. */
export async function waitForFixtureEvent(event: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!fixtureEvents().includes(event)) {
    if (Date.now() > deadline) {
      throw new Error(`Fixture event did not appear in time: ${event}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
