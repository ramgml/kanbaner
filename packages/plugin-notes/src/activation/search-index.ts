import {
  type PluginLogger,
  type PluginSearchService,
  type ResourceRef,
  type SearchDocumentInput,
  type SearchProvider,
  type SearchProviderFacet,
  type SearchHit,
} from "@kanbaner/plugin-sdk";

import { NOTE_RESOURCE_TYPE, NOTES_PLUGIN_ID } from "../constants.ts";
import type { Note } from "../model.ts";
import { formatNoteRef } from "../resources.ts";
import type { NotesStore } from "../store.ts";

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
}

/**
 * Нормализованный поисковый документ заметки.
 *
 * Содержимое заметки остаётся в домене; в индекс попадают только заголовок,
 * Markdown-текст и безопасные метаданные дерева.
 */
export function toNoteSearchDocument(note: Note): SearchDocumentInput {
  return {
    ref: formatNoteRef(note.id),
    title: note.title,
    text: note.contentMarkdown,
    kind: NOTE_RESOURCE_TYPE,
    updatedAt: note.updatedAt,
    metadata: {
      noteId: note.id,
      parentId: note.parentId,
      pluginId: NOTES_PLUGIN_ID,
    },
  };
}

/**
 * Обновляет поисковые документы заметок после коммита.
 *
 * Ошибка индекса не отменяет уже зафиксированную команду. Полная
 * переиндексация при следующей активации восстановит индекс.
 */
export async function upsertNoteSearchDocuments(
  search: PluginSearchService,
  notes: readonly Note[],
  logger: PluginLogger,
): Promise<void> {
  if (notes.length === 0) {
    return;
  }

  try {
    await search.upsert(notes.map((note) => toNoteSearchDocument(note)));
  } catch (error) {
    logger.warn("notes.search_upsert_failed", {
      count: notes.length,
      errorName: safeErrorName(error),
    });
  }
}

/** Удаляет документы всех переданных ресурсов; ошибки best-effort. */
export async function deleteNoteSearchDocuments(
  search: PluginSearchService,
  refs: readonly ResourceRef[],
  logger: PluginLogger,
): Promise<void> {
  for (const ref of refs) {
    try {
      await search.delete(ref);
    } catch (error) {
      logger.warn("notes.search_delete_failed", {
        resource: ref,
        errorName: safeErrorName(error),
      });
    }
  }
}

/**
 * Полная переиндексация заметок при активации.
 *
 * Всегда заменяет документы поиска своего namespace, включая пустой список:
 * это удаляет stale-документы заметок, которых уже нет в домене, и не трогает
 * tasks/fixture. Сбой пробрасывается, чтобы активация не оставила
 * зарегистрированного провайдера со stale-индексом.
 */
export async function reindexAllNotes(
  store: Pick<NotesStore, "listAllNotes">,
  search: PluginSearchService,
  logger: PluginLogger,
): Promise<number> {
  const notes = await store.listAllNotes();

  try {
    return await search.reindex(notes.map((note) => toNoteSearchDocument(note)));
  } catch (error) {
    logger.error("notes.search_reindex_failed", {
      count: notes.length,
      errorName: safeErrorName(error),
    });

    throw error;
  }
}

/**
 * SearchProvider домена заметок.
 *
 * Заметки не объявляют project/status/tags facet-ов: при таком фильтре
 * реестр исключает провайдера и не читает заметки вовсе.
 */
export function createNotesSearchProvider(
  store: Pick<NotesStore, "listAllNotes">,
  search: PluginSearchService,
  logger: PluginLogger,
): SearchProvider {
  return {
    id: NOTES_PLUGIN_ID,
    kinds: [{ id: NOTE_RESOURCE_TYPE, title: "Заметки" }],
    filterFields: [],

    listFacets(): Promise<readonly SearchProviderFacet[]> {
      return Promise.resolve([]);
    },

    search(query): Promise<readonly SearchHit[]> {
      return search.search({
        text: query.text,
        kind: NOTE_RESOURCE_TYPE,
        ...(query.filters === undefined ? {} : { filters: query.filters }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },

    reindex(): Promise<number> {
      return reindexAllNotes(store, search, logger);
    },
  };
}
