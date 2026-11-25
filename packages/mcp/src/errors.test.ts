// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  createFailure,
  failureForStatus,
  failureFromError,
  McpFailureError,
  protocolErrorData,
  readUpstreamFailure,
  redactText,
  REDACTED,
} from "./errors.ts";

const TOKEN = "secret-token-value";

describe("errors", () => {
  it("редактирует токен, управляющие символы и длину", () => {
    expect(redactText(`плохой ${TOKEN} запрос`, TOKEN)).toBe(`плохой ${REDACTED} запрос`);
    expect(redactText("a\u0000b", TOKEN)).toBe("a b");
    expect(redactText("x".repeat(600), undefined)).toHaveLength(500);
    expect(redactText("обычный текст")).toBe("обычный текст");
  });

  it("оставляет details только для безопасных кодов", () => {
    const safe = createFailure("VALIDATION_ERROR", "ошибка", {
      details: { issues: [{ path: "/id" }] },
    });
    const unsafe = createFailure("INTERNAL_ERROR", "ошибка", {
      details: { raw: "body" },
    });

    expect(safe.details).toEqual({ issues: [{ path: "/id" }] });
    expect(unsafe.details).toBeUndefined();
  });

  it("ставит retryable по коду", () => {
    expect(createFailure("DEPENDENCY_UNAVAILABLE", "нет связи").retryable).toBe(true);
    expect(createFailure("PERMISSION_DENIED", "нет доступа").retryable).toBe(false);
    expect(createFailure("DISCOVERY_INCOMPATIBLE", "старый сервер").retryable).toBe(false);
  });

  it("разбирает стабильный конверт ошибки и редактирует токен", () => {
    const failure = readUpstreamFailure(
      {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: `token ${TOKEN} отклонён`,
          retryable: false,
          details: { secret: "не отдавать" },
        },
      },
      TOKEN,
    );

    expect(failure).toEqual({
      code: "PERMISSION_DENIED",
      message: `token ${REDACTED} отклонён`,
      retryable: false,
    });
  });

  it("не доверяет неизвестному коду и битому конверту", () => {
    expect(readUpstreamFailure({ ok: false, error: { code: "NOPE" } })).toBeNull();
    expect(readUpstreamFailure({ ok: true, data: {} })).toBeNull();
    expect(readUpstreamFailure(null)).toBeNull();
  });

  it("маппит HTTP-статусы без тела", () => {
    expect(failureForStatus(401).code).toBe("PERMISSION_DENIED");
    expect(failureForStatus(403).retryable).toBe(false);
    expect(failureForStatus(503)).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
    });
    expect(failureForStatus(504)).toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(failureForStatus(500)).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
  });

  it("превращает неизвестное исключение в безопасную ошибку", () => {
    expect(failureFromError(new Error(`boom ${TOKEN}`), TOKEN).message).not.toContain(TOKEN);

    const known = new McpFailureError(createFailure("TIMEOUT", "таймаут"));

    expect(failureFromError(known)).toBe(known.failure);
  });

  it("отдаёт в протокол только код и retryable", () => {
    expect(protocolErrorData(createFailure("VALIDATION_ERROR", "ошибка"))).toEqual({
      code: "VALIDATION_ERROR",
      retryable: false,
    });
  });
});
