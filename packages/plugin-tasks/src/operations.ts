import type { CommandMetadata, QueryMetadata } from "@kanbaner/plugin-sdk";

import {
  TASKS_COMMAND_IDS,
  TASKS_COMMANDS_CONTRACT,
  TASKS_CONTRACT_VERSION,
  TASKS_QUERIES_CONTRACT,
  TASKS_QUERY_IDS,
} from "./constants.ts";
import {
  ColumnCreateInputSchema,
  ColumnDeleteInputSchema,
  ColumnDeleteOutputSchema,
  ColumnMoveInputSchema,
  ColumnMutationOutputSchema,
  ColumnUpdateInputSchema,
} from "./schemas/column.ts";
import {
  ProjectCreateInputSchema,
  ProjectDeleteInputSchema,
  ProjectDeleteOutputSchema,
  ProjectMutationOutputSchema,
  ProjectUpdateInputSchema,
} from "./schemas/project.ts";
import {
  ColumnListInputSchema,
  ColumnListOutputSchema,
  ProjectGetInputSchema,
  ProjectGetOutputSchema,
  ProjectListInputSchema,
  ProjectListOutputSchema,
  ProjectSummaryInputSchema,
  ProjectSummaryOutputSchema,
  TaskGetInputSchema,
  TaskGetOutputSchema,
  TaskListInputSchema,
  TaskListOutputSchema,
} from "./schemas/queries.ts";
import {
  TaskCompleteInputSchema,
  TaskCreateInputSchema,
  TaskDeleteInputSchema,
  TaskDeleteManyInputSchema,
  TaskDeleteManyOutputSchema,
  TaskDeleteOutputSchema,
  TaskMoveInputSchema,
  TaskMoveManyInputSchema,
  TaskMoveManyOutputSchema,
  TaskMutationOutputSchema,
  TaskUpdateInputSchema,
} from "./schemas/task.ts";

type JsonSchemaObject = CommandMetadata["inputSchema"];
type JsonSchemaResult = CommandMetadata["outputSchema"];

/**
 * TypeBox-схемы и `JsonObject` SDK описывают один и тот же JSON Schema, но
 * TypeBox добавляет фантомные типы. Приведение локализовано здесь, чтобы
 * метаданные команд остались обычными `CommandMetadata`.
 */
function inputSchema(schema: unknown): JsonSchemaObject {
  return schema as JsonSchemaObject;
}

function outputSchema(schema: unknown): JsonSchemaResult {
  return schema as JsonSchemaResult;
}

function commandMetadata(
  id: string,
  risk: CommandMetadata["risk"],
  schema: unknown,
  result: unknown,
  description: string,
): CommandMetadata {
  return {
    id,
    contract: TASKS_COMMANDS_CONTRACT,
    version: TASKS_CONTRACT_VERSION,
    kind: "mutation",
    risk,
    idempotency: "supported",
    inputSchema: inputSchema(schema),
    outputSchema: outputSchema(result),
    description,
  };
}

function queryMetadata(
  id: string,
  schema: unknown,
  result: unknown,
  description: string,
): QueryMetadata {
  return {
    id,
    contract: TASKS_QUERIES_CONTRACT,
    version: TASKS_CONTRACT_VERSION,
    kind: "query",
    risk: "read",
    inputSchema: inputSchema(schema),
    outputSchema: outputSchema(result),
    description,
  };
}

/** Метаданные всех команд домена задач. */
export const TASKS_COMMANDS = Object.freeze({
  projectCreate: commandMetadata(
    TASKS_COMMAND_IDS.projectCreate,
    "write",
    ProjectCreateInputSchema,
    ProjectMutationOutputSchema,
    "Создаёт проект задач с необязательным цветом доски",
  ),
  projectUpdate: commandMetadata(
    TASKS_COMMAND_IDS.projectUpdate,
    "write",
    ProjectUpdateInputSchema,
    ProjectMutationOutputSchema,
    "Изменяет проект, включая необязательный цвет, с проверкой expectedVersion",
  ),
  projectDelete: commandMetadata(
    TASKS_COMMAND_IDS.projectDelete,
    "destructive",
    ProjectDeleteInputSchema,
    ProjectDeleteOutputSchema,
    "Удаляет проект и его задачи после явного подтверждения",
  ),
  columnCreate: commandMetadata(
    TASKS_COMMAND_IDS.columnCreate,
    "write",
    ColumnCreateInputSchema,
    ColumnMutationOutputSchema,
    "Создаёт колонку проекта с необязательным цветом и упорядочивает соседей",
  ),
  columnUpdate: commandMetadata(
    TASKS_COMMAND_IDS.columnUpdate,
    "write",
    ColumnUpdateInputSchema,
    ColumnMutationOutputSchema,
    "Изменяет title и/или color колонки с проверкой expectedVersion",
  ),
  columnMove: commandMetadata(
    TASKS_COMMAND_IDS.columnMove,
    "write",
    ColumnMoveInputSchema,
    ColumnMutationOutputSchema,
    "Переставляет колонку и обновляет позиции соседей",
  ),
  columnDelete: commandMetadata(
    TASKS_COMMAND_IDS.columnDelete,
    "destructive",
    ColumnDeleteInputSchema,
    ColumnDeleteOutputSchema,
    "Удаляет колонку и атомарно переносит её задачи в targetColumnId",
  ),
  taskCreate: commandMetadata(
    TASKS_COMMAND_IDS.taskCreate,
    "write",
    TaskCreateInputSchema,
    TaskMutationOutputSchema,
    "Создаёт задачу или подзадачу первого уровня",
  ),
  taskUpdate: commandMetadata(
    TASKS_COMMAND_IDS.taskUpdate,
    "write",
    TaskUpdateInputSchema,
    TaskMutationOutputSchema,
    "Изменяет текстовые поля, приоритет, срок и теги задачи",
  ),
  taskMove: commandMetadata(
    TASKS_COMMAND_IDS.taskMove,
    "write",
    TaskMoveInputSchema,
    TaskMutationOutputSchema,
    "Меняет статус и позицию задачи",
  ),
  taskComplete: commandMetadata(
    TASKS_COMMAND_IDS.taskComplete,
    "write",
    TaskCompleteInputSchema,
    TaskMutationOutputSchema,
    "Переводит задачу в done и фиксирует completedAt",
  ),
  taskMoveMany: commandMetadata(
    TASKS_COMMAND_IDS.taskMoveMany,
    "write",
    TaskMoveManyInputSchema,
    TaskMoveManyOutputSchema,
    "Атомарно дописывает задачи в колонку в порядке входного массива",
  ),
  taskDelete: commandMetadata(
    TASKS_COMMAND_IDS.taskDelete,
    "destructive",
    TaskDeleteInputSchema,
    TaskDeleteOutputSchema,
    "Удаляет задачу и её подзадачи после явного подтверждения",
  ),
  taskDeleteMany: commandMetadata(
    TASKS_COMMAND_IDS.taskDeleteMany,
    "destructive",
    TaskDeleteManyInputSchema,
    TaskDeleteManyOutputSchema,
    "Атомарно удаляет набор задач и подзадачи после явного подтверждения",
  ),
} satisfies Record<string, CommandMetadata>);

/** Метаданные всех запросов домена задач. */
export const TASKS_QUERIES = Object.freeze({
  projectList: queryMetadata(
    TASKS_QUERY_IDS.projectList,
    ProjectListInputSchema,
    ProjectListOutputSchema,
    "Возвращает проекты стабильными страницами",
  ),
  projectGet: queryMetadata(
    TASKS_QUERY_IDS.projectGet,
    ProjectGetInputSchema,
    ProjectGetOutputSchema,
    "Возвращает проект по ID",
  ),
  projectSummary: queryMetadata(
    TASKS_QUERY_IDS.projectSummary,
    ProjectSummaryInputSchema,
    ProjectSummaryOutputSchema,
    "Возвращает точные счётчики и просроченные задачи по проектам",
  ),
  columnList: queryMetadata(
    TASKS_QUERY_IDS.columnList,
    ColumnListInputSchema,
    ColumnListOutputSchema,
    "Возвращает колонки проекта по position и id",
  ),
  taskGet: queryMetadata(
    TASKS_QUERY_IDS.taskGet,
    TaskGetInputSchema,
    TaskGetOutputSchema,
    "Возвращает задачу по ID",
  ),
  taskList: queryMetadata(
    TASKS_QUERY_IDS.taskList,
    TaskListInputSchema,
    TaskListOutputSchema,
    "Возвращает задачи с фильтрами, сортировкой и пагинацией",
  ),
} satisfies Record<string, QueryMetadata>);

/** Массив метаданных команд для регистрации в OperationBus. */
export const TASKS_COMMAND_LIST: readonly CommandMetadata[] = Object.freeze(
  Object.values(TASKS_COMMANDS),
);

/** Массив метаданных запросов для регистрации в OperationBus. */
export const TASKS_QUERY_LIST: readonly QueryMetadata[] = Object.freeze(
  Object.values(TASKS_QUERIES),
);
