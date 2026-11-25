export const DEFAULT_API_URL = "http://127.0.0.1:3000";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;
export const TOKEN_ENV_PREFIX = "KANBANER_API_TOKEN=";

/** Нормализованная конфигурация MCP-адаптера. */
export interface UniversalMcpConfig {
  /** Базовый URL HTTP API без завершающего `/`. */
  readonly apiUrl: string;
  /** Bearer token; никогда не попадает в сообщения и журналы. */
  readonly apiToken: string;
  readonly timeoutMs: number;
  readonly allowDestructive: boolean;
}

/** Ошибка конфигурации: сообщение безопасно и не содержит значений env. */
export class McpConfigError extends Error {
  override readonly name = "McpConfigError";
}

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Срезает случайный префикс `KANBANER_API_TOKEN=` из значения переменной.
 *
 * Повторяет поведение ручного MCP-адаптера, но не импортирует его код.
 */
export function normalizeApiToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  return trimmed.startsWith(TOKEN_ENV_PREFIX)
    ? trimmed.slice(TOKEN_ENV_PREFIX.length).trim()
    : trimmed;
}

/**
 * Приводит URL API к виду `origin + pathname` без завершающего `/`.
 *
 * Разрешены только HTTP(S), без credentials, query и hash: иначе Bearer
 * token мог бы уйти на чужой хост или попасть в журнал прокси.
 */
export function normalizeApiUrl(value: string | undefined): string {
  const raw = value?.trim();

  if (raw === undefined || raw.length === 0) {
    return DEFAULT_API_URL;
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new McpConfigError(
      "KANBANER_API_URL должен быть абсолютным HTTP(S) URL без credentials, query и hash",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpConfigError("KANBANER_API_URL должен использовать протокол HTTP или HTTPS");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new McpConfigError("KANBANER_API_URL не может содержать credentials");
  }

  if (url.search.length > 0 || url.hash.length > 0) {
    throw new McpConfigError("KANBANER_API_URL не может содержать query или hash");
  }

  const pathname = url.pathname.replace(/\/+$/u, "");

  return `${url.origin}${pathname}`;
}

export function parseTimeoutMs(value: string | undefined): number {
  const raw = value?.trim();

  if (raw === undefined || raw.length === 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (!/^\d+$/u.test(raw)) {
    throw new McpConfigError(
      `KANBANER_MCP_TIMEOUT_MS должен быть целым числом от 1 до ${MAX_TIMEOUT_MS}`,
    );
  }

  const parsed = Number(raw);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw new McpConfigError(
      `KANBANER_MCP_TIMEOUT_MS должен быть целым числом от 1 до ${MAX_TIMEOUT_MS}`,
    );
  }

  return parsed;
}

export function parseAllowDestructive(value: string | undefined): boolean {
  const raw = value?.trim();

  if (raw === undefined || raw.length === 0 || raw === "false") {
    return false;
  }

  if (raw === "true") {
    return true;
  }

  throw new McpConfigError("KANBANER_MCP_ALLOW_DESTRUCTIVE должен быть true или false");
}

/**
 * Загружает и проверяет конфигурацию.
 *
 * Ошибки называют только имя переменной и требование, но никогда не
 * печатают значение токена или URL.
 */
export function loadConfig(env: Environment): UniversalMcpConfig {
  const apiUrl = normalizeApiUrl(env["KANBANER_API_URL"]);
  const apiToken = normalizeApiToken(env["KANBANER_API_TOKEN"]);

  if (apiToken === undefined) {
    throw new McpConfigError("KANBANER_API_TOKEN не задан");
  }

  return {
    apiUrl,
    apiToken,
    timeoutMs: parseTimeoutMs(env["KANBANER_MCP_TIMEOUT_MS"]),
    allowDestructive: parseAllowDestructive(env["KANBANER_MCP_ALLOW_DESTRUCTIVE"]),
  };
}
