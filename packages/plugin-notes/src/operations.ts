import type { CommandMetadata, JsonObject, QueryMetadata } from "@kanbaner/plugin-sdk";

import {
  NOTES_COMMAND_IDS,
  NOTES_COMMANDS_CONTRACT,
  NOTES_CONTRACT_VERSION,
  NOTES_QUERIES_CONTRACT,
  NOTES_QUERY_IDS,
} from "./constants.ts";
import {
  NoteAttachmentCreateInputSchema,
  NoteAttachmentDeleteInputSchema,
  NoteAttachmentGetInputSchema,
  NoteAttachmentGetOutputSchema,
  NoteAttachmentOutputSchema,
  NoteCreateInputSchema,
  NoteDeleteInputSchema,
  NoteDeleteOutputSchema,
  NoteDetailsSchema,
  NoteExportInputSchema,
  NoteExportOutputSchema,
  NoteFavoriteInputSchema,
  NoteGetInputSchema,
  NoteLinkInputSchema,
  NoteLinksInputSchema,
  NoteLinksOutputSchema,
  NoteListInputSchema,
  NoteListOutputSchema,
  NoteMoveInputSchema,
  NoteMoveOutputSchema,
  NoteSearchInputSchema,
  NoteSearchOutputSchema,
  NoteUpdateInputSchema,
  NoteViewSchema,
  NoteVisitInputSchema,
  ResolvedNoteLinkSchema,
} from "./schemas.ts";

const asSchema = (schema: unknown): JsonObject => schema as JsonObject;
const NoteViewOutputSchema = { ...NoteViewSchema };

function command(
  id: string,
  risk: CommandMetadata["risk"],
  inputSchema: unknown,
  outputSchema: unknown,
  description: string,
  options: { idempotency?: "none" | "supported"; mcp?: boolean } = {},
): CommandMetadata {
  return {
    id,
    contract: NOTES_COMMANDS_CONTRACT,
    version: NOTES_CONTRACT_VERSION,
    kind: "mutation",
    risk,
    idempotency: options.idempotency ?? "supported",
    exposure: { ui: true, http: true, mcp: options.mcp ?? true },
    inputSchema: asSchema(inputSchema),
    outputSchema: asSchema(outputSchema),
    description,
  };
}

function query(
  id: string,
  inputSchema: unknown,
  outputSchema: unknown,
  description: string,
  mcp = true,
): QueryMetadata {
  return {
    id,
    contract: NOTES_QUERIES_CONTRACT,
    version: NOTES_CONTRACT_VERSION,
    kind: "query",
    risk: "read",
    exposure: { ui: true, http: true, mcp },
    inputSchema: asSchema(inputSchema),
    outputSchema: asSchema(outputSchema),
    description,
  };
}

const ViewOutput = TypeBoxObjectView();
function TypeBoxObjectView(): JsonObject {
  return asSchema({
    type: "object",
    properties: { view: NoteViewOutputSchema },
    required: ["view"],
  });
}

export const NOTES_COMMAND_LIST: readonly CommandMetadata[] = Object.freeze([
  command(
    NOTES_COMMAND_IDS.create,
    "write",
    NoteCreateInputSchema,
    NoteDetailsSchema,
    "Создаёт страницу заметок",
  ),
  command(
    NOTES_COMMAND_IDS.update,
    "write",
    NoteUpdateInputSchema,
    NoteDetailsSchema,
    "Обновляет заголовок или Markdown с expectedVersion",
  ),
  command(
    NOTES_COMMAND_IDS.move,
    "write",
    NoteMoveInputSchema,
    NoteMoveOutputSchema,
    "Перемещает страницу в дереве без циклов",
  ),
  command(
    NOTES_COMMAND_IDS.delete,
    "destructive",
    NoteDeleteInputSchema,
    NoteDeleteOutputSchema,
    "Каскадно удаляет ветку после confirm",
    { mcp: false },
  ),
  command(
    NOTES_COMMAND_IDS.favoriteSet,
    "write",
    NoteFavoriteInputSchema,
    ViewOutput,
    "Добавляет или убирает страницу из избранного",
  ),
  command(
    NOTES_COMMAND_IDS.recordVisit,
    "write",
    NoteVisitInputSchema,
    ViewOutput,
    "Фиксирует последнее открытие страницы",
    { mcp: false },
  ),
  command(
    NOTES_COMMAND_IDS.link,
    "write",
    NoteLinkInputSchema,
    ResolvedNoteLinkSchema,
    "Связывает заметку с ResourceRef",
    { idempotency: "none" },
  ),
  command(
    NOTES_COMMAND_IDS.unlink,
    "write",
    NoteLinkInputSchema,
    TypeBoxVoidSchema(),
    "Удаляет универсальную связь",
    { idempotency: "none" },
  ),
  command(
    NOTES_COMMAND_IDS.attachmentCreate,
    "write",
    NoteAttachmentCreateInputSchema,
    NoteAttachmentOutputSchema,
    "Сохраняет локальное растровое изображение",
  ),
  command(
    NOTES_COMMAND_IDS.attachmentDelete,
    "destructive",
    NoteAttachmentDeleteInputSchema,
    TypeBoxDeleteSchema(),
    "Удаляет неиспользуемое вложение",
    { mcp: false },
  ),
]);

function TypeBoxVoidSchema(): JsonObject {
  return asSchema({
    type: "object",
    properties: { unlinked: { type: "boolean" } },
    required: ["unlinked"],
  });
}
function TypeBoxDeleteSchema(): JsonObject {
  return asSchema({
    type: "object",
    properties: { deleted: { type: "boolean" } },
    required: ["deleted"],
  });
}

export const NOTES_QUERY_LIST: readonly QueryMetadata[] = Object.freeze([
  query(
    NOTES_QUERY_IDS.get,
    NoteGetInputSchema,
    NoteDetailsSchema,
    "Возвращает страницу, ancestors и attachments",
  ),
  query(
    NOTES_QUERY_IDS.list,
    NoteListInputSchema,
    NoteListOutputSchema,
    "Возвращает страницу дерева, favorite или recent",
  ),
  query(
    NOTES_QUERY_IDS.search,
    NoteSearchInputSchema,
    NoteSearchOutputSchema,
    "Ищет заметки по заголовку и Markdown",
  ),
  query(
    NOTES_QUERY_IDS.links,
    NoteLinksInputSchema,
    NoteLinksOutputSchema,
    "Возвращает связи и resolved descriptors",
  ),
  query(
    NOTES_QUERY_IDS.attachmentGet,
    NoteAttachmentGetInputSchema,
    NoteAttachmentGetOutputSchema,
    "Возвращает содержимое локального изображения",
    false,
  ),
  query(
    NOTES_QUERY_IDS.export,
    NoteExportInputSchema,
    NoteExportOutputSchema,
    "Экспортирует самодостаточный Markdown",
    false,
  ),
]);

export const NOTES_COMMANDS = Object.freeze(
  Object.fromEntries(NOTES_COMMAND_LIST.map((metadata) => [metadata.id, metadata])),
);
export const NOTES_QUERIES = Object.freeze(
  Object.fromEntries(NOTES_QUERY_LIST.map((metadata) => [metadata.id, metadata])),
);
