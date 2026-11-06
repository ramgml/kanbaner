import { StorageError } from "./errors.ts";

/** UTC timestamp в формате RFC 3339 с обязательным `Z`. */
export type UtcTimestamp = string;

/**
 * Преобразует `Date` в UTC timestamp без изменения часового пояса.
 *
 * Доменный код передаёт время в UTC; Store-контракт инкапсулирует строковый
 * формат и не зависит от драйвера backend.
 */
export function toUtcTimestamp(date: Date): UtcTimestamp {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new StorageError("INVALID_ARGUMENT", "Некорректная дата для UTC timestamp");
  }

  return date.toISOString();
}

/** Текущее UTC-время через внедряемый источник времени. */
export function currentUtcTimestamp(now: () => Date = () => new Date()): UtcTimestamp {
  const date = now();

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new StorageError("INTERNAL_ERROR", "Не удалось получить текущее UTC-время");
  }

  return date.toISOString();
}
