import { describe, expect, it } from "vitest";

import type { OperationResult } from "@kanbaner/plugin-sdk";

import { toUiOperationResult } from "./plugin-operation-result";

describe("UI transport ошибок", () => {
  it("передаёт только безопасный details.reason из конверта операции", () => {
    const envelope: OperationResult<unknown> = {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Превышена максимальная глубина дерева",
        retryable: false,
        details: {
          reason: "NOTE_TREE_TOO_DEEP",
          issues: [{ path: "/parentId", keyword: "maxDepth" }],
          operationId: "kanbaner.notes.note.move",
        },
      },
    };

    expect(toUiOperationResult(envelope)).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Превышена максимальная глубина дерева",
        retryable: false,
        details: { reason: "NOTE_TREE_TOO_DEEP" },
      },
    });
  });

  it("не пропускает нестроковый reason и другие details", () => {
    expect(
      toUiOperationResult({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Внутренняя ошибка",
          retryable: false,
          details: { reason: 42, secret: "не отдавать" },
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Внутренняя ошибка",
        retryable: false,
      },
    });
  });

  it("возвращает данные успешного вызова", () => {
    expect(toUiOperationResult({ ok: true, data: { total: 1 } })).toEqual({
      ok: true,
      data: { total: 1 },
    });
  });
});
