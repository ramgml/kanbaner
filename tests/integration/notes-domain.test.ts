// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStorageProvider, bindPluginStorage } from "@kanbaner/kernel";
import type { PluginStorage } from "@kanbaner/plugin-sdk";

import { NOTE_MAX_TREE_DEPTH } from "../../packages/plugin-notes/src/constants.ts";
import {
  NotesVersionConflictError,
  createNotesStore,
  type NotesStore,
} from "../../packages/plugin-notes/src/store.ts";
import {
  NOTE_ATTACHMENT_MIME_TYPES,
  type NoteAttachmentMimeType,
} from "../../packages/plugin-notes/src/model.ts";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const closers: Array<() => Promise<void>> = [];

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

async function createHarness(): Promise<{ storage: PluginStorage; store: NotesStore }> {
  const provider = new InMemoryStorageProvider({
    backendId: `notes-domain-${globalThis.crypto.randomUUID()}`,
  });

  await provider.open();
  closers.push(() => provider.close());

  const storage = bindPluginStorage(provider, "kanbaner.notes");

  return { storage, store: createNotesStore({ storage }) };
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

describe("NotesStore", () => {
  it("создаёт дерево, возвращает ancestors и сохраняет position", async () => {
    const { store } = await createHarness();

    const root = await store.createNote({
      id: "note-root",
      title: "  Корень  ",
      createdAt: timestamp(0),
    });

    expect(root.view.note).toMatchObject({
      id: "note-root",
      title: "Корень",
      parentId: null,
      position: 0,
      version: 1,
    });
    expect(root.ancestors).toEqual([]);
    expect(root.attachments).toEqual([]);

    const first = await store.createNote({
      id: "note-first",
      parentId: "note-root",
      title: "Первый",
      createdAt: timestamp(1),
    });
    const second = await store.createNote({
      id: "note-second",
      parentId: "note-root",
      title: "Второй",
      createdAt: timestamp(2),
    });

    expect(first.view.note.position).toBe(0);
    expect(second.view.note.position).toBe(1);

    const details = await store.getNote("note-second");

    expect(details?.ancestors.map((note) => note.id)).toEqual(["note-root"]);
    expect(details?.view.childCount).toBe(0);
    expect((await store.getNote("note-root"))?.view.childCount).toBe(2);

    const children = await store.listNotes({ parentId: "note-root" });

    expect(children.items.map((view) => view.note.id)).toEqual(["note-first", "note-second"]);
    expect(children.total).toBe(2);
    expect(children.nextOffset).toBeNull();
  });

  it("обновляет содержимое с expectedVersion и отклоняет устаревшую версию", async () => {
    const { store } = await createHarness();

    await store.createNote({ id: "note-1", title: "Заметка", createdAt: timestamp(0) });

    const updated = await store.updateNote({
      id: "note-1",
      expectedVersion: 1,
      contentMarkdown: "# Привет",
      updatedAt: timestamp(1),
    });

    expect(updated.view.note).toMatchObject({
      version: 2,
      title: "Заметка",
      contentMarkdown: "# Привет",
    });

    await expect(
      store.updateNote({
        id: "note-1",
        expectedVersion: 1,
        title: "Из другой сессии",
        updatedAt: timestamp(2),
      }),
    ).rejects.toBeInstanceOf(NotesVersionConflictError);

    const unchanged = await store.updateNote({
      id: "note-1",
      expectedVersion: 2,
      contentMarkdown: "# Привет",
      updatedAt: timestamp(3),
    });

    expect(unchanged.view.note.version).toBe(2);
  });

  it("не меняет версию заметки для favorite и recent", async () => {
    const { store } = await createHarness();

    await store.createNote({ id: "note-a", title: "A", createdAt: timestamp(0) });
    await store.createNote({ id: "note-b", title: "B", createdAt: timestamp(1) });

    const favorite = await store.setFavorite({
      id: "note-a",
      favorite: true,
      updatedAt: timestamp(2),
    });

    expect(favorite.favorite).toBe(true);
    expect(favorite.note.version).toBe(1);
    expect((await store.getNote("note-a"))?.view.note.version).toBe(1);

    const visitedA = await store.recordVisit({ id: "note-a", visitedAt: timestamp(3) });
    const visitedB = await store.recordVisit({ id: "note-b", visitedAt: timestamp(4) });

    expect(visitedA.lastOpenedAt).toBe(timestamp(3));
    expect(visitedB.lastOpenedAt).toBe(timestamp(4));
    expect(visitedA.note.version).toBe(1);
    expect((await store.getNote("note-b"))?.view.note.version).toBe(1);

    const favorites = await store.listNotes({ favorite: true });

    expect(favorites.items.map((view) => view.note.id)).toEqual(["note-a"]);

    const recent = await store.listNotes({ recent: true });

    expect(recent.items.map((view) => view.note.id)).toEqual(["note-b", "note-a"]);
  });

  it("перемещает ветку, переставляет соседей и запрещает циклы", async () => {
    const { store } = await createHarness();

    for (const id of ["note-root", "note-a", "note-b", "note-c"]) {
      await store.createNote({ id, title: id, createdAt: timestamp(0) });
    }

    const moved = await store.moveNote({
      id: "note-c",
      expectedVersion: 1,
      parentId: "note-a",
      updatedAt: timestamp(1),
    });

    expect(moved.note).toMatchObject({ id: "note-c", parentId: "note-a", position: 0 });
    expect(moved.affectedNotes.map((note) => note.id)).toEqual(["note-c"]);

    const reordered = await store.moveNote({
      id: "note-c",
      expectedVersion: 2,
      parentId: null,
      position: 0,
      updatedAt: timestamp(2),
    });

    expect(reordered.note).toMatchObject({ id: "note-c", parentId: null, position: 0 });
    expect(reordered.affectedNotes.map((note) => note.id)).toEqual([
      "note-a",
      "note-b",
      "note-c",
      "note-root",
    ]);

    await expect(
      store.moveNote({
        id: "note-c",
        expectedVersion: 3,
        parentId: "note-c",
        updatedAt: timestamp(3),
      }),
    ).rejects.toMatchObject({ reason: "NOTE_TREE_CYCLE" });

    await store.moveNote({
      id: "note-b",
      expectedVersion: 2,
      parentId: "note-c",
      updatedAt: timestamp(4),
    });

    await expect(
      store.moveNote({
        id: "note-c",
        expectedVersion: 3,
        parentId: "note-b",
        updatedAt: timestamp(5),
      }),
    ).rejects.toMatchObject({ reason: "NOTE_TREE_CYCLE" });
  });

  it("ограничивает глубину дерева", async () => {
    const { store } = await createHarness();

    let parentId: string | null = null;

    for (let depth = 0; depth < NOTE_MAX_TREE_DEPTH; depth += 1) {
      const id = `note-depth-${depth}`;

      await store.createNote({ id, parentId, title: id, createdAt: timestamp(0) });
      parentId = id;
    }

    await expect(
      store.createNote({
        id: "note-depth-overflow",
        parentId,
        title: "Слишком глубоко",
        createdAt: timestamp(0),
      }),
    ).rejects.toMatchObject({ reason: "NOTE_TREE_TOO_DEEP" });
  });

  it("каскадно удаляет ветку вместе с вложениями", async () => {
    const { store } = await createHarness();

    await store.createNote({ id: "note-root", title: "Корень", createdAt: timestamp(0) });
    await store.createNote({
      id: "note-child",
      parentId: "note-root",
      title: "Ребёнок",
      createdAt: timestamp(1),
    });
    await store.createNote({
      id: "note-grandchild",
      parentId: "note-child",
      title: "Внук",
      createdAt: timestamp(2),
    });

    await store.createAttachment({
      id: "attachment-1",
      noteId: "note-child",
      mimeType: "image/png",
      contentBase64: PNG_BASE64,
      createdAt: timestamp(3),
    });

    const deletion = await store.deleteNote({
      id: "note-root",
      expectedVersion: 1,
      confirm: true,
    });

    expect(deletion.deleted).toBe(true);

    if (deletion.deleted) {
      expect(deletion.deletedNotes.map((note) => note.id)).toEqual([
        "note-child",
        "note-grandchild",
        "note-root",
      ]);
      expect(deletion.deletedAttachmentIds).toEqual(["attachment-1"]);
      expect(deletion.deletedResourceRefs).toEqual([
        "kanbaner.notes:note:note-child",
        "kanbaner.notes:note:note-grandchild",
        "kanbaner.notes:note:note-root",
      ]);
    }

    expect(await store.getNote("note-root")).toBeNull();
    expect(await store.getAttachment("attachment-1")).toBeNull();

    expect(await store.deleteNote({ id: "note-root", expectedVersion: 1, confirm: true })).toEqual({
      deleted: false,
    });
  });

  it("сохраняет локальные изображения и встраивает их в экспорт", async () => {
    const { store } = await createHarness();

    await store.createNote({ id: "note-1", title: "Картинки", createdAt: timestamp(0) });

    const attachment = await store.createAttachment({
      id: "attachment-1",
      noteId: "note-1",
      mimeType: "image/png",
      contentBase64: PNG_BASE64,
      createdAt: timestamp(1),
    });

    expect(attachment).toMatchObject({ id: "attachment-1", mimeType: "image/png" });
    expect(attachment.sizeBytes).toBeGreaterThan(0);
    expect(await store.getAttachment("attachment-1")).not.toBeNull();
    expect(await store.listAttachments("note-1")).toHaveLength(1);

    await expect(
      store.updateNote({
        id: "note-1",
        expectedVersion: 1,
        contentMarkdown: "![Нет](attachment://attachment-unknown)",
        updatedAt: timestamp(2),
      }),
    ).rejects.toMatchObject({ reason: "ATTACHMENT_NOT_FOUND" });

    const withImage = await store.updateNote({
      id: "note-1",
      expectedVersion: 1,
      contentMarkdown: "Текст\n\n![Точка](attachment://attachment-1)\n",
      updatedAt: timestamp(3),
    });

    expect(withImage.attachments.map((descriptor) => descriptor.id)).toEqual(["attachment-1"]);

    const exported = await store.exportNote("note-1");

    expect(exported).toMatchObject({ fileName: "Картинки.md", mediaType: "text/markdown" });
    expect(exported?.content.startsWith("# Картинки\n")).toBe(true);
    expect(exported?.content).toContain(`data:image/png;base64,${PNG_BASE64}`);

    await expect(
      store.deleteAttachment({ id: "attachment-1", confirm: true }),
    ).rejects.toMatchObject({ reason: "ATTACHMENT_IN_USE" });

    await store.updateNote({
      id: "note-1",
      expectedVersion: 2,
      contentMarkdown: "Без картинки",
      updatedAt: timestamp(4),
    });

    expect(await store.deleteAttachment({ id: "attachment-1", confirm: true })).toBe(true);
  });

  it("отклоняет файл, не соответствующий заявленному MIME-типу", async () => {
    const { store } = await createHarness();

    await store.createNote({ id: "note-1", title: "Файл", createdAt: timestamp(0) });

    for (const mimeType of NOTE_ATTACHMENT_MIME_TYPES) {
      await expect(
        store.createAttachment({
          id: `attachment-${mimeType.replace("/", "-")}`,
          noteId: "note-1",
          mimeType: mimeType as NoteAttachmentMimeType,
          contentBase64: globalThis.btoa("plain text"),
          createdAt: timestamp(1),
        }),
      ).rejects.toMatchObject({ reason: "INVALID_ATTACHMENT" });
    }
  });
});
