// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  DEFAULT_API_URL,
  DEFAULT_TIMEOUT_MS,
  loadConfig,
  MAX_TIMEOUT_MS,
  McpConfigError,
  normalizeApiToken,
  normalizeApiUrl,
  parseAllowDestructive,
  parseTimeoutMs,
} from "./config.ts";

const TOKEN = "secret-token-value";

describe("config", () => {
  it("загружает значения по умолчанию", () => {
    const config = loadConfig({ KANBANER_API_TOKEN: ` ${TOKEN} ` });

    expect(config).toEqual({
      apiUrl: DEFAULT_API_URL,
      apiToken: TOKEN,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowDestructive: false,
    });
  });

  it("срезает префикс KANBANER_API_TOKEN=", () => {
    expect(normalizeApiToken(`KANBANER_API_TOKEN=${TOKEN}`)).toBe(TOKEN);
    expect(normalizeApiToken("   ")).toBeUndefined();
    expect(normalizeApiToken(undefined)).toBeUndefined();
  });

  it("требует токен и не печатает его значение", () => {
    for (const env of [{}, { KANBANER_API_TOKEN: "   " }]) {
      let error: unknown;

      try {
        loadConfig(env);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(McpConfigError);
      expect((error as Error).message).toContain("KANBANER_API_TOKEN");
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("нормализует URL API", () => {
    expect(normalizeApiUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(normalizeApiUrl("https://kanbaner.test/base///")).toBe("https://kanbaner.test/base");
    expect(normalizeApiUrl(undefined)).toBe(DEFAULT_API_URL);
    expect(normalizeApiUrl("  ")).toBe(DEFAULT_API_URL);
  });

  it("отклоняет небезопасный URL без вывода credentials", () => {
    for (const value of [
      "ftp://kanbaner.test",
      "http://user:password@kanbaner.test",
      "http://kanbaner.test/?token=value",
      "http://kanbaner.test/#fragment",
      "kanbaner.test",
    ]) {
      expect(() => normalizeApiUrl(value)).toThrow(McpConfigError);
    }

    let message = "";

    try {
      normalizeApiUrl("http://user:password@kanbaner.test");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain("password");
  });

  it("проверяет таймаут", () => {
    expect(parseTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseTimeoutMs("250")).toBe(250);
    expect(parseTimeoutMs(String(MAX_TIMEOUT_MS))).toBe(MAX_TIMEOUT_MS);

    for (const value of ["0", "-1", "1.5", "abc", String(MAX_TIMEOUT_MS + 1)]) {
      expect(() => parseTimeoutMs(value)).toThrow(McpConfigError);
    }
  });

  it("включает destructive только явным true", () => {
    expect(parseAllowDestructive(undefined)).toBe(false);
    expect(parseAllowDestructive("false")).toBe(false);
    expect(parseAllowDestructive("true")).toBe(true);

    for (const value of ["TRUE", "1", "yes"]) {
      expect(() => parseAllowDestructive(value)).toThrow(McpConfigError);
    }
  });
});
