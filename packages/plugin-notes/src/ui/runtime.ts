import type { JsonObject, JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

export interface UiOperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type UiOperationResult =
  | { readonly ok: true; readonly data: JsonValue | null }
  | { readonly ok: false; readonly error: UiOperationError };

/** Необязательные параметры вызова операции из UI. */
export interface UiInvokeOptions {
  /**
   * Ключ идемпотентности повторяемой мутации.
   *
   * Одинаковый ключ для одного снимка операции защищает от дубля при retry,
   * а изменение payload обязано давать новый ключ.
   */
  readonly idempotencyKey?: string;
}

export type UiOperationInvoker = (
  operationId: string,
  input: JsonValue,
  options?: UiInvokeOptions,
) => Promise<UiOperationResult>;

export interface NotesUiRendererProps {
  readonly invoke: UiOperationInvoker;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly context?: JsonObject | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
  readonly openResource?: ((ref: ResourceRef) => void) | undefined;
  readonly renderSlot?: ((slot: string, context?: JsonObject) => unknown) | undefined;
}

export class NotesUiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function invokeNotes<T>(
  invoke: UiOperationInvoker,
  operationId: string,
  input: JsonValue,
  options?: UiInvokeOptions,
): Promise<T> {
  const result = await invoke(operationId, input, options);
  if (!result.ok) {
    throw new NotesUiError(result.error.code, result.error.message, result.error.retryable);
  }
  return result.data as T;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as { readonly [key: string]: JsonValue }).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

/** FNV-1a: детерминированный короткий отпечаток снимка операции. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Ключ идемпотентности, стабильный по снимку операции.
 *
 * Пока payload не изменился, retry получает тот же ключ; любое изменение
 * входных данных даёт новый ключ.
 */
export function snapshotIdempotencyKey(namespace: string, payload: JsonValue): string {
  return `${namespace}:${fingerprint(stableStringify(payload))}`;
}

let operationKeySeed = 0;

/**
 * Уникальный ключ операции, который живёт до её успеха.
 *
 * Нужен созданиям: повторная попытка одного и того же создания получает тот
 * же ключ (и не создаёт дубль), а после успеха вызывающий сбрасывает ключ.
 */
export function newIdempotencyKey(namespace: string): string {
  operationKeySeed += 1;
  return `${namespace}:${Date.now().toString(36)}:${operationKeySeed.toString(36)}`;
}

export function noteIdFromSearch(search: string | undefined): string | null {
  const params = new URLSearchParams(search ?? "");
  const direct = params.get("note")?.trim();
  if (direct) {
    return direct;
  }

  const resource = params.get("resource")?.trim();
  if (resource) {
    const parts = resource.split(":");
    const id =
      parts.length === 3 && parts[0] === "kanbaner.notes" && parts[1] === "note"
        ? parts[2]
        : undefined;
    return id === undefined || id.length === 0 ? null : id;
  }
  return null;
}

export function searchWithNote(noteId: string | null, currentSearch = ""): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("resource");
  if (noteId === null) {
    params.delete("note");
  } else {
    params.set("note", noteId);
  }
  const serialized = params.toString();
  return serialized.length === 0 ? "" : `?${serialized}`;
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}
