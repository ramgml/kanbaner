import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  callKanbanerApi,
  normalizeApiToken,
  toolResult,
  type KanbanerApiConfig,
  type KanbanerCallIdentity,
} from "./mcp-support.ts";

const ID = z.string().min(1);
const EXPECTED_VERSION = z.number().int().min(0);
const TASK_EXPECTED_VERSION = z.number().int().min(1);
const PAGE = {
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};
const COLOR = z.enum(["default", "slate", "blue", "green", "yellow", "orange", "red", "purple"]);
const STATUS = z.enum(["backlog", "todo", "in_progress", "done"]);
const PRIORITY = z.enum(["low", "medium", "high"]);
const NULLABLE_ID = ID.nullable().optional();
const NULLABLE_TIMESTAMP = z.string().nullable().optional();

interface CallExtra {
  readonly requestId: string | number;
  readonly sessionId?: string;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

function identity(extra: CallExtra): KanbanerCallIdentity {
  const openCodeSession = extra._meta?.["ai.opencode/sessionID"];
  return {
    requestId: extra.requestId,
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    ...(typeof openCodeSession === "string" ? { openCodeSessionId: openCodeSession } : {}),
  };
}

export function createKanbanerMcpServer(
  config: KanbanerApiConfig = {
    apiUrl: process.env.KANBANER_API_URL ?? "http://127.0.0.1:3000",
    apiToken: normalizeApiToken(process.env.KANBANER_API_TOKEN),
  },
): McpServer {
  const scopedConfig: KanbanerApiConfig = {
    ...config,
    instanceId: config.instanceId ?? randomUUID(),
  };
  const server = new McpServer({ name: "kanbaner", version: "0.1.0-dev.0" });

  function query(
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    operationId: string,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.strictObject(inputSchema),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (input, extra) =>
        toolResult(
          await callKanbanerApi(
            scopedConfig,
            "queries",
            operationId,
            input,
            identity(extra),
            extra.signal,
          ),
        ),
    );
  }

  function command(
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    operationId: string,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.strictObject(inputSchema),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (input, extra) =>
        toolResult(
          await callKanbanerApi(
            scopedConfig,
            "commands",
            operationId,
            input,
            identity(extra),
            extra.signal,
          ),
        ),
    );
  }

  query("project_list", "Список проектов Kanbaner", PAGE, "kanbaner.tasks.project.list");
  query("project_get", "Проект по ID", { id: ID }, "kanbaner.tasks.project.get");
  command(
    "project_create",
    "Создать проект",
    {
      title: z.string().min(1).max(200),
      descriptionMarkdown: z.string().optional(),
      color: COLOR.optional(),
    },
    "kanbaner.tasks.project.create",
  );
  command(
    "project_update",
    "Обновить проект с expectedVersion",
    {
      id: ID,
      expectedVersion: TASK_EXPECTED_VERSION,
      title: z.string().min(1).max(200).optional(),
      descriptionMarkdown: z.string().optional(),
      color: COLOR.optional(),
    },
    "kanbaner.tasks.project.update",
  );

  query(
    "task_list",
    "Список задач с фильтрами",
    {
      projectId: ID.optional(),
      columnId: ID.optional(),
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      tag: z.string().optional(),
      parentTaskId: NULLABLE_ID,
      text: z.string().optional(),
      dueBefore: z.string().optional(),
      dueAfter: z.string().optional(),
      sort: z
        .strictObject({
          field: z.enum(["position", "createdAt", "updatedAt", "dueAt", "title"]),
          direction: z.enum(["asc", "desc"]),
        })
        .optional(),
      ...PAGE,
    },
    "kanbaner.tasks.task.list",
  );
  query("task_get", "Задача по ID", { id: ID }, "kanbaner.tasks.task.get");
  command(
    "task_create",
    "Создать задачу",
    {
      projectId: ID,
      parentTaskId: NULLABLE_ID,
      columnId: ID.optional(),
      title: z.string().min(1).max(200),
      descriptionMarkdown: z.string().optional(),
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      dueAt: NULLABLE_TIMESTAMP,
      position: z.number().int().min(0).optional(),
      tags: z.array(z.string()).optional(),
    },
    "kanbaner.tasks.task.create",
  );
  command(
    "task_update",
    "Обновить задачу с expectedVersion",
    {
      id: ID,
      expectedVersion: TASK_EXPECTED_VERSION,
      title: z.string().min(1).max(200).optional(),
      descriptionMarkdown: z.string().optional(),
      priority: PRIORITY.optional(),
      dueAt: NULLABLE_TIMESTAMP,
      tags: z.array(z.string()).optional(),
    },
    "kanbaner.tasks.task.update",
  );
  command(
    "task_complete",
    "Завершить задачу с expectedVersion",
    { id: ID, expectedVersion: TASK_EXPECTED_VERSION },
    "kanbaner.tasks.task.complete",
  );
  command(
    "task_move",
    "Переместить задачу в колонку с expectedVersion",
    {
      id: ID,
      expectedVersion: TASK_EXPECTED_VERSION,
      columnId: ID.optional(),
      status: STATUS.optional(),
      position: z.number().int().min(0),
    },
    "kanbaner.tasks.task.move",
  );

  query(
    "note_list",
    "Список заметок с фильтрами",
    {
      parentId: NULLABLE_ID,
      favorite: z.boolean().optional(),
      recent: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    "kanbaner.notes.note.list",
  );
  query("note_get", "Заметка по ID", { id: ID }, "kanbaner.notes.note.get");
  command(
    "note_create",
    "Создать заметку",
    {
      parentId: NULLABLE_ID,
      title: z.string().max(200).optional(),
      contentMarkdown: z.string().optional(),
    },
    "kanbaner.notes.note.create",
  );
  command(
    "note_update",
    "Обновить заголовок или Markdown заметки с expectedVersion",
    {
      id: ID,
      expectedVersion: EXPECTED_VERSION,
      title: z.string().max(200).optional(),
      contentMarkdown: z.string().optional(),
    },
    "kanbaner.notes.note.update",
  );

  return server;
}
