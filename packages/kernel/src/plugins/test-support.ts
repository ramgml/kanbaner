import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getFixtureRecords, resetFixtureRecords } from "./__fixtures__/records.ts";

const FIXTURES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/** Абсолютный путь к каталогу fixture-сценария. */
export function fixturePath(...parts: string[]): string {
  return join(FIXTURES_DIRECTORY, ...parts);
}

/** Очищает журнал fixture-модулей между тестами. */
export function resetFixtures(): void {
  resetFixtureRecords();
}

/** События fixture-модулей в порядке выполнения. */
export function fixtureEvents(): readonly string[] {
  return getFixtureRecords();
}
