import {
  type PluginLogger,
  type PluginSearchService,
  type ResourceRef,
  type SearchDocumentInput,
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
 * Читает все заметки домена и заменяет документы поиска. Сбой индекса не
 * отменяет активацию: поиск восстановится при следующем запуске.
 */
export async function reindexAllNotes(
  store: Pick<NotesStore, "listAllNotes">,
  search: PluginSearchService,
  logger: PluginLogger,
): Promise<number> {
  const notes = await store.listAllNotes();

  // Пустой домен нечего индексировать: не занимаем транзакцию поиска на старте.
  // Заметок без плагина не возникает, поэтому stale-документов быть не может.
  if (notes.length === 0) {
    return 0;
  }

  try {
    return await search.reindex(notes.map((note) => toNoteSearchDocument(note)));
  } catch (error) {
    logger.warn("notes.search_reindex_failed", {
      count: notes.length,
      errorName: safeErrorName(error),
    });

    return 0;
  }
}
