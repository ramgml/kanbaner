import type { OpenCodeToolSource, OpenCodeToolView } from "./types.ts";

/**
 * Стандартные built-in tools, явно разрешённые агенту `kanbaner` в
 * `opencode.jsonc` (решение пользователя от 2026-11-20).
 *
 * `edit` покрывает инструменты `edit`, `write` и `patch`; `external_directory`
 * является отдельным permission action для путей вне проекта. Это не sandbox:
 * read/edit/shell имеют доступ к локальным файлам и секретам, а websearch,
 * webfetch и shell — к сети.
 */
export const OPENCODE_BUILTIN_TOOLS: readonly OpenCodeToolView[] = Object.freeze([
  {
    name: "question",
    description: "Задать пользователю уточняющий вопрос",
    risk: "read",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "websearch",
    description: "Поиск в интернете по запросу",
    risk: "read",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "webfetch",
    description: "Загрузить страницу по HTTP(S) URL",
    risk: "read",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "read",
    description: "Прочитать файл или каталог",
    risk: "read",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "glob",
    description: "Найти файлы по glob-шаблону",
    risk: "read",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "grep",
    description: "Найти текст в файлах регулярным выражением",
    risk: "read",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "edit",
    description: "Изменить, создать или удалить файл (edit/write/patch)",
    risk: "write",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "shell",
    description: "Выполнить команду в shell с правами пользователя",
    risk: "write",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "subagent",
    description: "Запустить дочернего агента OpenCode",
    risk: "write",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "skill",
    description: "Загрузить инструкции доступного skill",
    risk: "read",
    source: "builtin",
    requiresExpectedVersion: false,
  },
  {
    name: "external_directory",
    description: "Доступ к каталогам вне проекта",
    risk: "write",
    source: "builtin",
    requiresExpectedVersion: false,
  },
]);

/**
 * Единый публичный MCP allowlist: отображается в UI и сверяется с фактическим
 * MCP list. OpenCode регистрирует MCP server как `kanbaner`, поэтому модели
 * видны имена с префиксом `kanbaner_`; сам MCP server публикует имя без префикса.
 */
export const OPENCODE_MCP_TOOLS: readonly OpenCodeToolView[] = Object.freeze([
  {
    name: "kanbaner_project_list",
    description: "Список проектов Kanbaner",
    operationId: "kanbaner.tasks.project.list",
    risk: "read",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_project_get",
    description: "Проект по ID",
    operationId: "kanbaner.tasks.project.get",
    risk: "read",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_project_create",
    description: "Создать проект",
    operationId: "kanbaner.tasks.project.create",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_project_update",
    description: "Обновить проект с expectedVersion",
    operationId: "kanbaner.tasks.project.update",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: true,
  },
  {
    name: "kanbaner_task_list",
    description: "Список задач с фильтрами",
    operationId: "kanbaner.tasks.task.list",
    risk: "read",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_task_get",
    description: "Задача по ID",
    operationId: "kanbaner.tasks.task.get",
    risk: "read",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_task_create",
    description: "Создать задачу",
    operationId: "kanbaner.tasks.task.create",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_task_update",
    description: "Обновить задачу с expectedVersion",
    operationId: "kanbaner.tasks.task.update",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: true,
  },
  {
    name: "kanbaner_task_complete",
    description: "Завершить задачу с expectedVersion",
    operationId: "kanbaner.tasks.task.complete",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: true,
  },
  {
    name: "kanbaner_task_move",
    description: "Переместить задачу в колонку с expectedVersion",
    operationId: "kanbaner.tasks.task.move",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: true,
  },
  {
    name: "kanbaner_note_list",
    description: "Список заметок с фильтрами",
    operationId: "kanbaner.notes.note.list",
    risk: "read",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_note_get",
    description: "Заметка по ID",
    operationId: "kanbaner.notes.note.get",
    risk: "read",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_note_create",
    description: "Создать заметку",
    operationId: "kanbaner.notes.note.create",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: false,
  },
  {
    name: "kanbaner_note_update",
    description: "Обновить заголовок или Markdown заметки с expectedVersion",
    operationId: "kanbaner.notes.note.update",
    risk: "write",
    source: "mcp",
    requiresExpectedVersion: true,
  },
]);

/** Catalog отдаёт built-ins и ручной MCP allowlist как единый список с source. */
export const OPENCODE_CATALOG_TOOLS: readonly OpenCodeToolView[] = Object.freeze([
  ...OPENCODE_BUILTIN_TOOLS,
  ...OPENCODE_MCP_TOOLS,
]);

/** Fallback по имени сохраняет совместимость со старыми catalog fixtures без source. */
export function opencodeToolSource(tool: OpenCodeToolView): OpenCodeToolSource {
  if (tool.source !== undefined) return tool.source;
  return tool.name.startsWith("kanbaner_") ? "mcp" : "builtin";
}
