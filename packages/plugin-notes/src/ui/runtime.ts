import type { JsonObject, JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

export interface UiOperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type UiOperationResult =
  | { readonly ok: true; readonly data: JsonValue | null }
  | { readonly ok: false; readonly error: UiOperationError };

export type UiOperationInvoker = (
  operationId: string,
  input: JsonValue,
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
): Promise<T> {
  const result = await invoke(operationId, input);
  if (!result.ok) {
    throw new NotesUiError(result.error.code, result.error.message, result.error.retryable);
  }
  return result.data as T;
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
