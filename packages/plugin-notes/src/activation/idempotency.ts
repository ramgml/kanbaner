import { createHash } from "node:crypto";

import {
  isStorageErrorShape,
  type JsonValue,
  type PluginDocumentStore,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import { NOTES_IDEMPOTENCY_COLLECTION, NOTES_PLUGIN_ID } from "../constants.ts";

/** Срок хранения записи идемпотентности: 24 часа. */
export const NOTES_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

/** Код конфликта повторного использования ключа. */
export const IDEMPOTENCY_CONFLICT_CODE = "IDEMPOTENCY_CONFLICT" as const;

/** Ключ уже использован другой операцией или с другим нормализованным вводом. */
export class IdempotencyConflictError extends Error {
  override readonly name = "IdempotencyConflictError";
  readonly code = IDEMPOTENCY_CONFLICT_CODE;

  constructor(message = "Idempotency-Key уже использован другой операцией") {
    super(message);
  }
}

/** Сохранённая запись идемпотентности. */
interface IdempotencyRecord {
  readonly operationId: string;
  readonly keyHash: string;
  readonly inputHash: string;
  readonly result: JsonValue;
  readonly createdAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}

/** Результат проверки ключа внутри транзакции. */
export type IdempotencyCheck =
  | { readonly status: "replay"; readonly result: JsonValue }
  | { readonly status: "miss"; readonly expectedVersion: number };

/** Вход проверки ключа. */
export interface IdempotencyCheckInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly inputHash: string;
  readonly now: UtcTimestamp;
}

/** Вход записи результата. */
export interface IdempotencySaveInput extends IdempotencyCheckInput {
  readonly result: JsonValue;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => canonicalize(item));
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }

    return sorted;
  }

  return value;
}

/**
 * Детерминированное JSON-представление нормализованного ввода.
 *
 * Ключи объектов сортируются рекурсивно, поэтому одинаковый по смыслу ввод
 * даёт одинаковый hash независимо от порядка полей.
 */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));

  return serialized ?? "null";
}

/** Стабильный SHA-256 в hex. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** ID записи идемпотентности: hash от operationId и ключа. */
export function idempotencyRecordId(operationId: string, idempotencyKey: string): string {
  return sha256Hex(`kanbaner.notes.idempotency\n${operationId}\n${idempotencyKey}`);
}

/** Стабильный hash ввода для сравнения payload. */
export function hashIdempotencyInput(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

function isRecord(value: unknown): value is IdempotencyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.operationId === "string" &&
    typeof record.keyHash === "string" &&
    typeof record.inputHash === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.expiresAt === "string" &&
    "result" in record
  );
}

function isExpired(record: IdempotencyRecord, now: UtcTimestamp): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  const current = Date.parse(now);

  if (!Number.isFinite(expiresAt) || !Number.isFinite(current)) {
    return true;
  }

  return expiresAt <= current;
}

/**
 * Проверяет ключ в текущей транзакции.
 *
 * Запись с истёкшим TTL игнорируется. Ключ, использованный другой операцией
 * (поиск по `keyHash`), даёт `IdempotencyConflictError`. Вызывающая сторона
 * обязана выполнить проверку, мутацию и запись результата в одной транзакции.
 */
export async function checkIdempotency(
  documents: PluginDocumentStore,
  input: IdempotencyCheckInput,
): Promise<IdempotencyCheck> {
  const id = idempotencyRecordId(input.operationId, input.idempotencyKey);
  const document = await documents.get(NOTES_PLUGIN_ID, NOTES_IDEMPOTENCY_COLLECTION, id);
  const expectedVersion = document === null ? 0 : document.version;
  const stored = document === null ? null : document.data;

  if (document !== null && isRecord(stored) && !isExpired(stored, input.now)) {
    if (stored.operationId !== input.operationId || stored.inputHash !== input.inputHash) {
      throw new IdempotencyConflictError();
    }

    return { status: "replay", result: stored.result };
  }

  // ID включает operationId, поэтому ключ, использованный другой командой,
  // ищется отдельно по стабильному hash ключа. Записи с истёкшим TTL не
  // блокируют повторное использование.
  const keyHash = sha256Hex(input.idempotencyKey);
  const sameKey = await documents.query({
    pluginId: NOTES_PLUGIN_ID,
    collection: NOTES_IDEMPOTENCY_COLLECTION,
    indexedFields: { keyHash },
  });

  for (const record of sameKey) {
    if (record.id === id) {
      continue;
    }

    if (!isRecord(record.data)) {
      continue;
    }

    if (isExpired(record.data, input.now)) {
      continue;
    }

    if (record.data.operationId !== input.operationId) {
      throw new IdempotencyConflictError();
    }
  }

  return { status: "miss", expectedVersion };
}

/**
 * Сохраняет результат успешной команды в текущей транзакции.
 *
 * Запись выполняется после доменной мутации. Если запись не удалась,
 * исключение откатывает всю транзакцию, поэтому частичного успеха и «висящей»
 * записи без мутации не возникает.
 */
export async function saveIdempotency(
  documents: PluginDocumentStore,
  input: IdempotencySaveInput,
  expectedVersion: number,
): Promise<void> {
  const createdAt = input.now;
  const expiresAt = new Date(Date.parse(createdAt) + NOTES_IDEMPOTENCY_TTL_MS).toISOString();
  const record: IdempotencyRecord = {
    operationId: input.operationId,
    keyHash: sha256Hex(input.idempotencyKey),
    inputHash: input.inputHash,
    result: input.result,
    createdAt,
    expiresAt,
  };

  try {
    await documents.put({
      pluginId: NOTES_PLUGIN_ID,
      collection: NOTES_IDEMPOTENCY_COLLECTION,
      id: idempotencyRecordId(input.operationId, input.idempotencyKey),
      data: record as unknown as JsonValue,
      indexedFields: { keyHash: record.keyHash },
      expectedVersion,
    });
  } catch (error) {
    if (isStorageErrorShape(error) && error.code === "VERSION_CONFLICT") {
      throw new IdempotencyConflictError(
        "Idempotency-Key одновременно использован другой операцией",
      );
    }

    throw error;
  }
}
