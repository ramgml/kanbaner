import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "@kanbaner/plugin-notes/contract";
import type { JsonValue, OperationResult } from "@kanbaner/plugin-sdk";
import { TASKS_COMMAND_IDS, TASKS_QUERY_IDS } from "@kanbaner/plugin-tasks/contract";

import { KanbanerApiClient, type ApiRequestOptions } from "./client.ts";
import { CliFailure, usageError } from "./errors.ts";

const CLI_OPTIONS = {
  help: { type: "boolean", short: "h" },
  pretty: { type: "boolean" },
  url: { type: "string" },
  "timeout-ms": { type: "string" },
  "request-id": { type: "string" },
  "idempotency-key": { type: "string" },
  input: { type: "string" },
  "input-file": { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  content: { type: "string" },
  color: { type: "string" },
  project: { type: "string" },
  column: { type: "string" },
  status: { type: "string" },
  priority: { type: "string" },
  tag: { type: "string", multiple: true },
  parent: { type: "string" },
  text: { type: "string" },
  "due-at": { type: "string" },
  "due-before": { type: "string" },
  "due-after": { type: "string" },
  sort: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  "expected-version": { type: "string" },
  "expected-descendants": { type: "string" },
  position: { type: "string" },
  favorite: { type: "string" },
  recent: { type: "string" },
  confirm: { type: "boolean" },
} as const;

type OptionDefinition = (typeof CLI_OPTIONS)[keyof typeof CLI_OPTIONS];
type OptionValue<Definition extends OptionDefinition> = Definition["type"] extends "boolean"
  ? boolean
  : Definition extends { readonly multiple: true }
    ? string[]
    : string;
type CliValues = {
  readonly [Key in keyof typeof CLI_OPTIONS]?: OptionValue<(typeof CLI_OPTIONS)[Key]>;
};

export interface CliIo {
  write(text: string): void;
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
}

export interface RunCliOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly io?: CliIo;
}

type Invocation =
  | { readonly type: "health" | "discovery" }
  | { readonly type: "resource"; readonly ref: string }
  | {
      readonly type: "command" | "query";
      readonly operationId: string;
      readonly input: JsonValue;
    };

const GLOBAL_OPTIONS = new Set(["help", "pretty", "url", "timeout-ms", "request-id"]);
const MUTATION_OPTIONS = ["idempotency-key"] as const;
const PAGE_OPTIONS = ["limit", "offset"] as const;

const HELP = `Kanbaner CLI — JSON-клиент HTTP API для агентов.

Конфигурация:
  KANBANER_API_URL      URL приложения (по умолчанию http://127.0.0.1:3000)
  KANBANER_API_TOKEN    Bearer token; обязателен для всего, кроме health

Универсальные команды:
  kanbaner health
  kanbaner discovery
  kanbaner command <commandId> [--input '<json>' | --input-file <path|->]
  kanbaner query <queryId> [--input '<json>' | --input-file <path|->]
  kanbaner resource <resourceRef>

Доменные сокращения:
  project list|get|create|update|delete
  column list
  task list|get|create|update|move|complete|delete
  note list|get|search|create|update|move|favorite|delete|link|unlink|links|export

Общие флаги:
  --url <url> --timeout-ms <n> --request-id <id> --pretty
  --idempotency-key <key> доступен для команд-мутаций
  --confirm обязателен для доменных delete-команд

stdout содержит один OperationResult JSON. Коды выхода:
  0 — успех; 1 — ошибка API; 2 — аргументы/конфигурация; 3 — транспорт/протокол.

Полное описание флагов: packages/cli/README.md.`;

function defaultIo(): CliIo {
  return {
    write(text) {
      process.stdout.write(`${text}\n`);
    },
    async readStdin() {
      process.stdin.setEncoding("utf8");
      let input = "";

      for await (const chunk of process.stdin) {
        input += chunk as string;
      }

      return input;
    },
    readFile(path) {
      return readFile(path, "utf8");
    },
  };
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function assertOptions(values: CliValues, allowed: readonly string[]): void {
  const allowedOptions = new Set([...GLOBAL_OPTIONS, ...allowed]);

  for (const name of Object.keys(values)) {
    if (!allowedOptions.has(name)) {
      throw usageError(`Флаг --${name} не поддерживается этой командой`);
    }
  }
}

function expectLength(positionals: readonly string[], length: number, usage: string): void {
  if (positionals.length !== length) {
    throw usageError(`Ожидается: ${usage}`);
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw usageError(`Обязателен --${name}`);
  }

  return value;
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^-?\d+$/u.test(value)) {
    throw usageError(`--${name} должен быть целым числом`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw usageError(`--${name} выходит за безопасный диапазон целых чисел`);
  }

  return parsed;
}

function requiredInteger(value: string | undefined, name: string): number {
  const parsed = integer(value, name);

  if (parsed === undefined) {
    throw usageError(`Обязателен --${name}`);
  }

  return parsed;
}

function boolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw usageError(`--${name} принимает true или false`);
}

function nullable(value: string | undefined, name: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === "null" ? null : required(value, name);
}

function confirmed(value: boolean | undefined): true {
  if (value !== true) {
    throw usageError("Разрушительная операция требует --confirm");
  }

  return true;
}

function page(values: CliValues) {
  const limit = integer(values.limit, "limit");
  const offset = integer(values.offset, "offset");

  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

function requestOptions(values: CliValues): ApiRequestOptions {
  return {
    ...(values["request-id"] === undefined ? {} : { requestId: values["request-id"] }),
    ...(values["idempotency-key"] === undefined
      ? {}
      : { idempotencyKey: values["idempotency-key"] }),
  };
}

async function genericInput(values: CliValues, io: CliIo): Promise<JsonValue> {
  if (values.input !== undefined && values["input-file"] !== undefined) {
    throw usageError("--input и --input-file нельзя использовать одновременно");
  }

  let source: string | undefined = values.input;

  if (values["input-file"] !== undefined) {
    try {
      source =
        values["input-file"] === "-"
          ? await io.readStdin()
          : await io.readFile(values["input-file"]);
    } catch {
      throw usageError("Не удалось прочитать JSON input");
    }
  } else if (source === "-") {
    source = await io.readStdin();
  }

  if (source === undefined) {
    return {};
  }

  try {
    return JSON.parse(source) as JsonValue;
  } catch {
    throw usageError("Input должен содержать корректный JSON");
  }
}

function projectInvocation(positionals: readonly string[], values: CliValues): Invocation {
  const action = positionals[1];

  switch (action) {
    case "list":
      expectLength(positionals, 2, "project list [--limit n] [--offset n]");
      assertOptions(values, PAGE_OPTIONS);
      return {
        type: "query",
        operationId: TASKS_QUERY_IDS.projectList,
        input: json(page(values)),
      };
    case "get": {
      expectLength(positionals, 3, "project get <id>");
      assertOptions(values, []);
      return {
        type: "query",
        operationId: TASKS_QUERY_IDS.projectGet,
        input: json({ id: positionals[2] }),
      };
    }
    case "create":
      expectLength(positionals, 2, "project create --title <title>");
      assertOptions(values, ["title", "description", "color", ...MUTATION_OPTIONS]);
      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.projectCreate,
        input: json({
          title: required(values.title, "title"),
          ...(values.description === undefined ? {} : { descriptionMarkdown: values.description }),
          ...(values.color === undefined ? {} : { color: values.color }),
        }),
      };
    case "update": {
      expectLength(positionals, 3, "project update <id> --expected-version <n>");
      assertOptions(values, [
        "expected-version",
        "title",
        "description",
        "color",
        ...MUTATION_OPTIONS,
      ]);
      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.projectUpdate,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          ...(values.title === undefined ? {} : { title: values.title }),
          ...(values.description === undefined ? {} : { descriptionMarkdown: values.description }),
          ...(values.color === undefined ? {} : { color: values.color }),
        }),
      };
    }
    case "delete":
      expectLength(positionals, 3, "project delete <id> --expected-version <n> --confirm");
      assertOptions(values, ["expected-version", "confirm", ...MUTATION_OPTIONS]);
      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.projectDelete,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          confirm: confirmed(values.confirm),
        }),
      };
    default:
      throw usageError("Неизвестная project-команда", { reason: "unknown_domain_command" });
  }
}

function columnInvocation(positionals: readonly string[], values: CliValues): Invocation {
  if (positionals[1] !== "list") {
    throw usageError("Поддерживается column list; остальные операции доступны через command/query");
  }

  expectLength(positionals, 2, "column list --project <id>");
  assertOptions(values, ["project", ...PAGE_OPTIONS]);

  return {
    type: "query",
    operationId: TASKS_QUERY_IDS.columnList,
    input: json({ projectId: required(values.project, "project"), ...page(values) }),
  };
}

function taskInvocation(positionals: readonly string[], values: CliValues): Invocation {
  const action = positionals[1];

  switch (action) {
    case "list": {
      expectLength(positionals, 2, "task list [filters]");
      assertOptions(values, [
        "project",
        "column",
        "status",
        "priority",
        "tag",
        "parent",
        "text",
        "due-before",
        "due-after",
        "sort",
        ...PAGE_OPTIONS,
      ]);

      if (values.tag !== undefined && values.tag.length !== 1) {
        throw usageError("task list принимает не более одного --tag");
      }

      const parent = nullable(values.parent, "parent");

      return {
        type: "query",
        operationId: TASKS_QUERY_IDS.taskList,
        input: json({
          ...(values.project === undefined ? {} : { projectId: values.project }),
          ...(values.column === undefined ? {} : { columnId: values.column }),
          ...(values.status === undefined ? {} : { status: values.status }),
          ...(values.priority === undefined ? {} : { priority: values.priority }),
          ...(values.tag?.[0] === undefined ? {} : { tag: values.tag[0] }),
          ...(parent === undefined ? {} : { parentTaskId: parent }),
          ...(values.text === undefined ? {} : { text: values.text }),
          ...(values["due-before"] === undefined ? {} : { dueBefore: values["due-before"] }),
          ...(values["due-after"] === undefined ? {} : { dueAfter: values["due-after"] }),
          ...(values.sort === undefined ? {} : { sort: values.sort }),
          ...page(values),
        }),
      };
    }
    case "get":
      expectLength(positionals, 3, "task get <id>");
      assertOptions(values, []);
      return {
        type: "query",
        operationId: TASKS_QUERY_IDS.taskGet,
        input: json({ id: positionals[2] }),
      };
    case "create": {
      expectLength(positionals, 2, "task create --project <id> --title <title>");
      assertOptions(values, [
        "project",
        "parent",
        "column",
        "title",
        "description",
        "status",
        "priority",
        "due-at",
        "position",
        "tag",
        ...MUTATION_OPTIONS,
      ]);
      const parent = nullable(values.parent, "parent");
      const dueAt = nullable(values["due-at"], "due-at");
      const position = integer(values.position, "position");

      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.taskCreate,
        input: json({
          projectId: required(values.project, "project"),
          title: required(values.title, "title"),
          ...(parent === undefined ? {} : { parentTaskId: parent }),
          ...(values.column === undefined ? {} : { columnId: values.column }),
          ...(values.description === undefined ? {} : { descriptionMarkdown: values.description }),
          ...(values.status === undefined ? {} : { status: values.status }),
          ...(values.priority === undefined ? {} : { priority: values.priority }),
          ...(dueAt === undefined ? {} : { dueAt }),
          ...(position === undefined ? {} : { position }),
          ...(values.tag === undefined ? {} : { tags: values.tag }),
        }),
      };
    }
    case "update": {
      expectLength(positionals, 3, "task update <id> --expected-version <n>");
      assertOptions(values, [
        "expected-version",
        "title",
        "description",
        "priority",
        "due-at",
        "tag",
        ...MUTATION_OPTIONS,
      ]);
      const dueAt = nullable(values["due-at"], "due-at");

      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.taskUpdate,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          ...(values.title === undefined ? {} : { title: values.title }),
          ...(values.description === undefined ? {} : { descriptionMarkdown: values.description }),
          ...(values.priority === undefined ? {} : { priority: values.priority }),
          ...(dueAt === undefined ? {} : { dueAt }),
          ...(values.tag === undefined ? {} : { tags: values.tag }),
        }),
      };
    }
    case "move": {
      expectLength(
        positionals,
        3,
        "task move <id> --expected-version <n> --position <n> (--column <id> | --status <status>)",
      );
      assertOptions(values, [
        "expected-version",
        "column",
        "status",
        "position",
        ...MUTATION_OPTIONS,
      ]);

      if (values.column === undefined && values.status === undefined) {
        throw usageError("task move требует --column или --status");
      }

      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.taskMove,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          position: requiredInteger(values.position, "position"),
          ...(values.column === undefined ? {} : { columnId: values.column }),
          ...(values.status === undefined ? {} : { status: values.status }),
        }),
      };
    }
    case "complete":
      expectLength(positionals, 3, "task complete <id> --expected-version <n>");
      assertOptions(values, ["expected-version", ...MUTATION_OPTIONS]);
      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.taskComplete,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
        }),
      };
    case "delete":
      expectLength(positionals, 3, "task delete <id> --expected-version <n> --confirm");
      assertOptions(values, ["expected-version", "confirm", ...MUTATION_OPTIONS]);
      return {
        type: "command",
        operationId: TASKS_COMMAND_IDS.taskDelete,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          confirm: confirmed(values.confirm),
        }),
      };
    default:
      throw usageError("Неизвестная task-команда", { reason: "unknown_domain_command" });
  }
}

function noteInvocation(positionals: readonly string[], values: CliValues): Invocation {
  const action = positionals[1];

  switch (action) {
    case "list": {
      expectLength(positionals, 2, "note list [--parent id|null] [filters]");
      assertOptions(values, ["parent", "favorite", "recent", ...PAGE_OPTIONS]);
      const parent = nullable(values.parent, "parent");
      const favorite = boolean(values.favorite, "favorite");
      const recent = boolean(values.recent, "recent");

      return {
        type: "query",
        operationId: NOTES_QUERY_IDS.list,
        input: json({
          ...(parent === undefined ? {} : { parentId: parent }),
          ...(favorite === undefined ? {} : { favorite }),
          ...(recent === undefined ? {} : { recent }),
          ...page(values),
        }),
      };
    }
    case "get":
      expectLength(positionals, 3, "note get <id>");
      assertOptions(values, []);
      return {
        type: "query",
        operationId: NOTES_QUERY_IDS.get,
        input: json({ id: positionals[2] }),
      };
    case "search":
      expectLength(positionals, 3, "note search <text>");
      assertOptions(values, PAGE_OPTIONS);
      return {
        type: "query",
        operationId: NOTES_QUERY_IDS.search,
        input: json({ text: positionals[2], ...page(values) }),
      };
    case "create": {
      expectLength(positionals, 2, "note create [--title title] [--content markdown]");
      assertOptions(values, ["parent", "title", "content", ...MUTATION_OPTIONS]);
      const parent = nullable(values.parent, "parent");

      return {
        type: "command",
        operationId: NOTES_COMMAND_IDS.create,
        input: json({
          ...(parent === undefined ? {} : { parentId: parent }),
          ...(values.title === undefined ? {} : { title: values.title }),
          ...(values.content === undefined ? {} : { contentMarkdown: values.content }),
        }),
      };
    }
    case "update":
      expectLength(positionals, 3, "note update <id> --expected-version <n>");
      assertOptions(values, ["expected-version", "title", "content", ...MUTATION_OPTIONS]);
      return {
        type: "command",
        operationId: NOTES_COMMAND_IDS.update,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          ...(values.title === undefined ? {} : { title: values.title }),
          ...(values.content === undefined ? {} : { contentMarkdown: values.content }),
        }),
      };
    case "move": {
      expectLength(positionals, 3, "note move <id> --expected-version <n> --parent <id|null>");
      assertOptions(values, ["expected-version", "parent", "position", ...MUTATION_OPTIONS]);
      const parent = nullable(values.parent, "parent");
      const position = integer(values.position, "position");

      if (parent === undefined) {
        throw usageError("Обязателен --parent; для корня используйте --parent null");
      }

      return {
        type: "command",
        operationId: NOTES_COMMAND_IDS.move,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          parentId: parent,
          ...(position === undefined ? {} : { position }),
        }),
      };
    }
    case "favorite": {
      expectLength(positionals, 3, "note favorite <id> --favorite <true|false>");
      assertOptions(values, ["favorite", ...MUTATION_OPTIONS]);
      const favorite = boolean(values.favorite, "favorite");

      if (favorite === undefined) {
        throw usageError("Обязателен --favorite true|false");
      }

      return {
        type: "command",
        operationId: NOTES_COMMAND_IDS.favoriteSet,
        input: json({ id: positionals[2], favorite }),
      };
    }
    case "delete": {
      expectLength(positionals, 3, "note delete <id> --expected-version <n> --confirm");
      assertOptions(values, [
        "expected-version",
        "expected-descendants",
        "confirm",
        ...MUTATION_OPTIONS,
      ]);
      const expectedDescendants = integer(values["expected-descendants"], "expected-descendants");

      return {
        type: "command",
        operationId: NOTES_COMMAND_IDS.delete,
        input: json({
          id: positionals[2],
          expectedVersion: requiredInteger(values["expected-version"], "expected-version"),
          ...(expectedDescendants === undefined ? {} : { expectedDescendants }),
          confirm: confirmed(values.confirm),
        }),
      };
    }
    case "link":
      expectLength(positionals, 4, "note link <noteId> <targetRef>");
      assertOptions(values, MUTATION_OPTIONS);
      return {
        type: "command",
        operationId: NOTES_COMMAND_IDS.link,
        input: json({ noteId: positionals[2], targetRef: positionals[3] }),
      };
    case "unlink":
      expectLength(positionals, 5, "note unlink <noteId> <sourceRef> <targetRef>");
      assertOptions(values, MUTATION_OPTIONS);
      return {
        type: "command",
        operationId: NOTES_COMMAND_IDS.unlink,
        input: json({
          noteId: positionals[2],
          sourceRef: positionals[3],
          targetRef: positionals[4],
        }),
      };
    case "links":
      expectLength(positionals, 3, "note links <ref>");
      assertOptions(values, []);
      return {
        type: "query",
        operationId: NOTES_QUERY_IDS.links,
        input: json({ ref: positionals[2] }),
      };
    case "export":
      expectLength(positionals, 3, "note export <id>");
      assertOptions(values, []);
      return {
        type: "query",
        operationId: NOTES_QUERY_IDS.export,
        input: json({ id: positionals[2] }),
      };
    default:
      throw usageError("Неизвестная note-команда", { reason: "unknown_domain_command" });
  }
}

async function resolveInvocation(
  positionals: readonly string[],
  values: CliValues,
  io: CliIo,
): Promise<Invocation> {
  const root = positionals[0];

  switch (root) {
    case "health":
      expectLength(positionals, 1, "health");
      assertOptions(values, []);
      return { type: "health" };
    case "discovery":
      expectLength(positionals, 1, "discovery");
      assertOptions(values, []);
      return { type: "discovery" };
    case "resource":
      expectLength(positionals, 2, "resource <resourceRef>");
      assertOptions(values, []);
      return { type: "resource", ref: positionals[1] ?? "" };
    case "command":
    case "query": {
      expectLength(positionals, 2, `${root} <operationId> [--input json]`);
      assertOptions(
        values,
        root === "command" ? ["input", "input-file", ...MUTATION_OPTIONS] : ["input", "input-file"],
      );
      return {
        type: root,
        operationId: positionals[1] ?? "",
        input: await genericInput(values, io),
      };
    }
    case "project":
      return projectInvocation(positionals, values);
    case "column":
      return columnInvocation(positionals, values);
    case "task":
      return taskInvocation(positionals, values);
    case "note":
      return noteInvocation(positionals, values);
    default:
      throw usageError("Неизвестная команда; используйте --help", {
        reason: "unknown_command",
      });
  }
}

function serialize(result: OperationResult<unknown>, pretty: boolean): string {
  return JSON.stringify(result, null, pretty ? 2 : undefined);
}

function isArgumentParsingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as { readonly code?: unknown }).code;

  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

/** Запускает CLI с изолированными env/fetch/io для unit- и integration-тестов. */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo();
  let pretty = false;

  try {
    const parsed = parseArgs({
      args: [...argv],
      options: CLI_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const values = parsed.values as CliValues;
    const positionals = parsed.positionals;
    pretty = values.pretty === true;

    if (values.help === true || positionals.length === 0) {
      io.write(HELP);

      return 0;
    }

    const invocation = await resolveInvocation(positionals, values, io);
    const timeoutMs = integer(values["timeout-ms"], "timeout-ms");
    const env = options.env ?? process.env;
    const baseUrl = values.url ?? env.KANBANER_API_URL;
    const token = env.KANBANER_API_TOKEN;
    const client = new KanbanerApiClient({
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(token === undefined ? {} : { token }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const apiOptions = requestOptions(values);
    let result: OperationResult<unknown>;

    switch (invocation.type) {
      case "health":
        result = await client.health(apiOptions);
        break;
      case "discovery":
        result = await client.discovery(apiOptions);
        break;
      case "resource":
        result = await client.resource(invocation.ref, apiOptions);
        break;
      case "command":
        result = await client.command(invocation.operationId, invocation.input, apiOptions);
        break;
      case "query":
        result = await client.query(invocation.operationId, invocation.input, apiOptions);
        break;
    }

    io.write(serialize(result, pretty));

    return result.ok ? 0 : 1;
  } catch (error) {
    const failure =
      error instanceof CliFailure
        ? error
        : isArgumentParsingError(error)
          ? usageError("Неверные аргументы CLI", { reason: "argument_parsing" })
          : new CliFailure("INTERNAL_ERROR", "Не удалось выполнить CLI команду", 3);

    io.write(serialize(failure.result, pretty));

    return failure.exitCode;
  }
}
