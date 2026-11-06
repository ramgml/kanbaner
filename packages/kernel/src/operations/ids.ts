import { randomUUID } from "node:crypto";

/** Создаёт идентификатор запроса через криптографический генератор Node.js. */
export function createRequestId(): string {
  return randomUUID();
}

/** Создаёт идентификатор трассировки через криптографический генератор Node.js. */
export function createTraceId(): string {
  return randomUUID();
}
