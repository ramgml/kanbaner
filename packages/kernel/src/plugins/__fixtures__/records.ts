const RECORDS_KEY = "__kanbanerKernelFixtureRecords";

interface FixtureStore {
  events: string[];
}

function store(): FixtureStore {
  const holder = globalThis as unknown as Record<string, FixtureStore | undefined>;
  const existing = holder[RECORDS_KEY];

  if (existing !== undefined) {
    return existing;
  }

  const created: FixtureStore = { events: [] };
  holder[RECORDS_KEY] = created;

  return created;
}

/** Очищает журнал событий fixture-модулей. */
export function resetFixtureRecords(): void {
  store().events.length = 0;
}

/** Возвращает копию журнала событий fixture-модулей. */
export function getFixtureRecords(): readonly string[] {
  return [...store().events];
}

/** Добавляет событие в журнал; используется lifecycle hook-тестами. */
export function recordFixtureEvent(kind: string, pluginId: string): void {
  store().events.push(`${kind}:${pluginId}`);
}
