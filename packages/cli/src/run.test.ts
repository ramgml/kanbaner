// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { OperationResult } from "@kanbaner/plugin-sdk";

import { runCli, type CliIo } from "./run.ts";

interface HarnessOptions {
  readonly response?: OperationResult<unknown>;
  readonly rawResponse?: string;
  readonly networkError?: Error;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
}

async function run(args: readonly string[], options: HarnessOptions = {}) {
  const output: string[] = [];
  const fetchMock = vi.fn(async () => {
    if (options.networkError !== undefined) {
      throw options.networkError;
    }

    if (options.rawResponse !== undefined) {
      return new Response(options.rawResponse, { status: 502 });
    }

    return Response.json(options.response ?? { ok: true, data: { accepted: true } });
  });
  const io: CliIo = {
    write(text) {
      output.push(text);
    },
    readStdin: async () => options.stdin ?? "",
    readFile: async () => {
      throw new Error("unexpected file read");
    },
  };
  const exitCode = await runCli(args, {
    env: options.env ?? {
      KANBANER_API_URL: "http://localhost:3100",
      KANBANER_API_TOKEN: "agent-token",
    },
    fetch: fetchMock,
    io,
  });

  return { output, fetchMock, exitCode };
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[0];

  if (call === undefined) {
    throw new Error("fetch не вызван");
  }

  const [input, init] = call as [string, RequestInit];

  return {
    url: input,
    init,
    headers: new Headers(init.headers),
    body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
  };
}

function outputOf(output: readonly string[]): OperationResult<unknown> {
  expect(output).toHaveLength(1);

  return JSON.parse(output[0] ?? "") as OperationResult<unknown>;
}

describe("Kanbaner CLI", () => {
  it("вызывает универсальную команду с JSON, request ID и idempotency key", async () => {
    const harness = await run([
      "command",
      "kanbaner.tasks.project.create",
      "--input",
      '{"title":"From agent"}',
      "--request-id",
      "request-1",
      "--idempotency-key",
      "idem-1",
    ]);
    const request = requestOf(harness.fetchMock);

    expect(harness.exitCode).toBe(0);
    expect(request.url).toBe("http://localhost:3100/api/v1/commands/kanbaner.tasks.project.create");
    expect(request.init.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer agent-token");
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(request.headers.get("idempotency-key")).toBe("idem-1");
    expect(request.body).toEqual({ title: "From agent" });
    expect(outputOf(harness.output)).toEqual({ ok: true, data: { accepted: true } });
  });

  it("читает универсальный query input из stdin только по явному '-'", async () => {
    const harness = await run(["query", "kanbaner.tasks.task.list", "--input-file", "-"], {
      stdin: '{"projectId":"project-1","limit":10}',
    });
    const request = requestOf(harness.fetchMock);

    expect(harness.exitCode).toBe(0);
    expect(request.url).toBe("http://localhost:3100/api/v1/queries/kanbaner.tasks.task.list");
    expect(request.body).toEqual({ projectId: "project-1", limit: 10 });
  });

  it("преобразует project create в контрактный payload", async () => {
    const harness = await run([
      "project",
      "create",
      "--title",
      "Project",
      "--description",
      "Markdown",
      "--color",
      "blue",
    ]);

    expect(requestOf(harness.fetchMock).body).toEqual({
      title: "Project",
      descriptionMarkdown: "Markdown",
      color: "blue",
    });
  });

  it("сохраняет фильтры task list, числа и parent null", async () => {
    const harness = await run([
      "task",
      "list",
      "--project",
      "project-1",
      "--status",
      "todo",
      "--tag",
      "Agent",
      "--parent",
      "null",
      "--limit",
      "25",
      "--offset",
      "5",
    ]);

    expect(requestOf(harness.fetchMock).body).toEqual({
      projectId: "project-1",
      status: "todo",
      tag: "Agent",
      parentTaskId: null,
      limit: 25,
      offset: 5,
    });
  });

  it("преобразует note update и повторяемые task tags", async () => {
    const note = await run([
      "note",
      "update",
      "note-1",
      "--expected-version",
      "3",
      "--content",
      "# Title",
    ]);

    expect(requestOf(note.fetchMock).body).toEqual({
      id: "note-1",
      expectedVersion: 3,
      contentMarkdown: "# Title",
    });

    const task = await run([
      "task",
      "create",
      "--project",
      "project-1",
      "--title",
      "Task",
      "--tag",
      "one",
      "--tag",
      "two",
    ]);

    expect(requestOf(task.fetchMock).body).toMatchObject({ tags: ["one", "two"] });
  });

  it("требует явный --confirm для delete и не делает запрос без него", async () => {
    const harness = await run(["task", "delete", "task-1", "--expected-version", "2"]);

    expect(harness.exitCode).toBe(2);
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(outputOf(harness.output)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });

    const confirmed = await run([
      "task",
      "delete",
      "task-1",
      "--expected-version",
      "2",
      "--confirm",
    ]);

    expect(requestOf(confirmed.fetchMock).body).toMatchObject({ confirm: true });
  });

  it("требует целевую колонку или статус для task move", async () => {
    const harness = await run([
      "task",
      "move",
      "task-1",
      "--expected-version",
      "2",
      "--position",
      "0",
    ]);

    expect(harness.exitCode).toBe(2);
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(outputOf(harness.output)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("отклоняет пустые query/hash в базовом URL до HTTP", async () => {
    for (const url of ["http://127.0.0.1:3000?", "http://127.0.0.1:3000#"]) {
      const harness = await run(["health", "--url", url]);

      expect(harness.exitCode).toBe(2);
      expect(harness.fetchMock).not.toHaveBeenCalled();
    }
  });

  it("возвращает исходный конверт ошибки API с кодом выхода 1", async () => {
    const response: OperationResult<unknown> = {
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        message: "Conflict",
        retryable: false,
        details: { actualVersion: 4 },
      },
    };
    const harness = await run(["project", "list"], { response });

    expect(harness.exitCode).toBe(1);
    expect(outputOf(harness.output)).toEqual(response);
  });

  it("не раскрывает детали transport exception и возвращает код 3", async () => {
    const harness = await run(["project", "list"], {
      networkError: new Error("connection failed with agent-token"),
    });
    const output = outputOf(harness.output);

    expect(harness.exitCode).toBe(3);
    expect(output).toMatchObject({ ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } });
    expect(harness.output[0]).not.toContain("agent-token");
  });

  it("отклоняет malformed JSON и неизвестные флаги до HTTP", async () => {
    const malformed = await run(["query", "kanbaner.tasks.task.list", "--input", "{bad"]);

    expect(malformed.exitCode).toBe(2);
    expect(malformed.fetchMock).not.toHaveBeenCalled();

    const unknown = await run(["project", "list", "--unknown", "value"]);

    expect(unknown.exitCode).toBe(2);
    expect(unknown.fetchMock).not.toHaveBeenCalled();
    expect(outputOf(unknown.output)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR", details: { reason: "argument_parsing" } },
    });
  });

  it("не отправляет token в health и не требует его для health", async () => {
    const harness = await run(["health"], { env: {} });
    const request = requestOf(harness.fetchMock);

    expect(harness.exitCode).toBe(0);
    expect(request.url).toBe("http://127.0.0.1:3000/api/v1/health");
    expect(request.headers.has("authorization")).toBe(false);
  });

  it("отклоняет не-JSON ответ сервера как ошибку протокола", async () => {
    const harness = await run(["project", "list"], { rawResponse: "not-json" });
    const output = outputOf(harness.output);

    expect(harness.exitCode).toBe(3);
    expect(output).toMatchObject({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        details: { reason: "invalid_response", httpStatus: 502 },
      },
    });
  });
});
