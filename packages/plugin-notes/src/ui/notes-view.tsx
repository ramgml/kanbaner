"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Download,
  FileText,
  Menu,
  PanelLeftClose,
  Plus,
  Save,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type { ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import { extractAttachmentIds } from "../markdown-attachments.ts";
import type {
  Note,
  NoteAttachment,
  NoteAttachmentDescriptor,
  NoteAttachmentMimeType,
  NoteDeleteResult,
  NoteDetails,
  NoteExport,
  NoteListPage,
  NoteMoveResult,
  NoteSearchPage,
  NoteSubtree,
  NoteView,
} from "../model.ts";
import { AttachmentUrlCache } from "./attachment-cache.ts";
import { downloadMarkdownExport } from "./download.ts";
import { MarkdownNoteEditor } from "./editor/markdown-note-editor.tsx";
import { NoteLinks } from "./note-links.tsx";
import { NoteTree } from "./note-tree.tsx";
import {
  fileToBase64,
  invokeNotes,
  newIdempotencyKey,
  noteIdFromSearch,
  NotesUiError,
  searchWithNote,
  snapshotIdempotencyKey,
  type NotesUiRendererProps,
} from "./runtime.ts";

type Filter = "tree" | "favorite" | "recent";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

type NotesViewProps = NotesUiRendererProps;

const inputClass =
  "rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Предки заметки из плоского списка: от корня к родителю. */
function ancestorsOf(note: Note, items: readonly NoteView[]): readonly Note[] {
  const byId = new Map(items.map((item) => [item.note.id, item.note] as const));
  const ancestors: Note[] = [];
  const seen = new Set([note.id]);
  let parentId = note.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    ancestors.unshift(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return ancestors;
}

export function NotesView(props: NotesViewProps) {
  const { invoke, search, replaceSearch, openResource } = props;
  const [items, setItems] = useState<readonly NoteView[]>([]);
  const [details, setDetails] = useState<NoteDetails | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => noteIdFromSearch(search));
  const [filter, setFilter] = useState<Filter>("tree");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState(false);
  const [title, setTitle] = useState("");
  const [editorValue, setEditorValue] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<NoteSearchPage | null>(null);

  const cacheRef = useRef(new AttachmentUrlCache());
  const selectedIdRef = useRef(selectedId);
  const titleRef = useRef("");
  const contentRef = useRef("");
  const versionRef = useRef(0);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const attachmentsRef = useRef<readonly NoteAttachmentDescriptor[]>([]);
  const loadSequenceRef = useRef(0);
  /** Растёт при каждом изменении черновика; защищает ввод от загрузки. */
  const draftRevisionRef = useRef(0);
  /** Ключ создания живёт до успеха, чтобы retry не создавал дубль. */
  const createKeyRef = useRef<{ readonly key: string; readonly parentId: string | null } | null>(
    null,
  );
  const uploadKeyRef = useRef<{
    readonly key: string;
    readonly fingerprint: string;
  } | null>(null);
  const uploadChainRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const updateUrl = useCallback(
    (id: string | null) => {
      const next = searchWithNote(id, window.location.search);
      if (replaceSearch) replaceSearch(next);
      else window.history.replaceState(null, "", `${window.location.pathname}${next}`);
    },
    [replaceSearch],
  );

  const refreshNotes = useCallback(async (): Promise<readonly NoteView[]> => {
    const all: NoteView[] = [];
    let offset = 0;
    for (;;) {
      const page = await invokeNotes<NoteListPage>(invoke, NOTES_QUERY_IDS.list, {
        limit: 100,
        offset,
      });
      all.push(...page.items);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    setItems(all);
    return all;
  }, [invoke]);

  const saveNow = useCallback((): Promise<void> => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveChainRef.current = saveChainRef.current
      .then(async () => {
        const id = selectedIdRef.current;
        if (id === null || !dirtyRef.current) return;
        // Снимок операции: все решения после await принимаются по этим данным,
        // а не по refs, которые могла изменить другая открытая заметка.
        const snapshot = {
          id,
          title: titleRef.current,
          content: contentRef.current,
          expectedVersion: versionRef.current,
        };
        setSaveState("saving");
        setConflict(false);

        let next: NoteDetails;
        try {
          next = await invokeNotes<NoteDetails>(
            invoke,
            NOTES_COMMAND_IDS.update,
            {
              id: snapshot.id,
              expectedVersion: snapshot.expectedVersion,
              title: snapshot.title,
              contentMarkdown: snapshot.content,
            },
            {
              idempotencyKey: snapshotIdempotencyKey("note-update", {
                id: snapshot.id,
                expectedVersion: snapshot.expectedVersion,
                title: snapshot.title,
                contentMarkdown: snapshot.content,
              }),
            },
          );
        } catch (reason) {
          if (selectedIdRef.current !== snapshot.id) return;
          setSaveState("error");
          setConflict(reason instanceof NotesUiError && reason.code === "VERSION_CONFLICT");
          setError(reason instanceof Error ? reason.message : "Не удалось сохранить заметку");
          return;
        }

        // Пока запрос был в полёте, пользователь мог открыть другую заметку:
        // её refs, details и состояние сохранения менять нельзя.
        if (selectedIdRef.current !== snapshot.id) return;

        versionRef.current = next.view.note.version;
        setError(null);
        const draftUnchanged =
          titleRef.current === snapshot.title && contentRef.current === snapshot.content;
        if (draftUnchanged) {
          dirtyRef.current = false;
          setSaveState("saved");
        } else {
          setSaveState("dirty");
        }
        setDetails((current) =>
          current?.view.note.id === snapshot.id
            ? { ...next, attachments: attachmentsRef.current }
            : current,
        );
        void refreshNotes().catch(() => undefined);
        // Автоматическая очистка attachments запрещена: Undo может выполняться
        // как во время update, так и во время delete. Неиспользуемые файлы
        // удаляются только явным действием пользователя после сохранения.
      })
      .catch(() => undefined);
    return saveChainRef.current;
  }, [invoke, refreshNotes]);

  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") {
        void saveNowRef.current();
      }
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
      // SPA-навигация не вызывает beforeunload: save command стартует до unmount.
      void saveNowRef.current();
    };
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveNow();
    }, 700);
  }, [saveNow]);

  const loadNote = useCallback(
    async (id: string, updateLocation = true) => {
      const sequence = ++loadSequenceRef.current;
      const revisionAtStart = draftRevisionRef.current;
      const sameNoteAtStart = selectedIdRef.current === id;
      setLoading(true);
      setError(null);
      setConflict(false);
      try {
        const next = await invokeNotes<NoteDetails>(invoke, NOTES_QUERY_IDS.get, { id });
        const loadedAttachments = await Promise.all(
          next.attachments.map(async (attachment) => {
            const result = await invokeNotes<{ attachment: NoteAttachment }>(
              invoke,
              NOTES_QUERY_IDS.attachmentGet,
              { id: attachment.id },
            );
            return result.attachment;
          }),
        );
        if (sequence !== loadSequenceRef.current) return;

        // Ввод, начавшийся после старта get/attachmentGet, не затирается:
        // для той же заметки сохраняем черновик, dirty и состояние сохранения.
        const draftChanged = draftRevisionRef.current !== revisionAtStart;
        const keepDraft = sameNoteAtStart && draftChanged;

        const cache = new AttachmentUrlCache();
        for (const attachment of loadedAttachments) cache.add(attachment);
        cacheRef.current = cache;
        attachmentsRef.current = next.attachments;
        selectedIdRef.current = id;
        versionRef.current = next.view.note.version;
        setSelectedId(id);
        setDetails(next);
        if (!keepDraft) {
          titleRef.current = next.view.note.title;
          contentRef.current = next.view.note.contentMarkdown;
          dirtyRef.current = false;
          setTitle(next.view.note.title);
          setEditorValue(cache.toEditor(next.view.note.contentMarkdown));
          setSaveState("idle");
        }
        setSearchResults(null);
        if (updateLocation) updateUrl(id);
        setSidebarOpen(false);
        void invokeNotes(invoke, NOTES_COMMAND_IDS.recordVisit, { id })
          .then(() => refreshNotes())
          .catch(() => undefined);
      } catch (reason) {
        if (sequence === loadSequenceRef.current) {
          setError(reason instanceof Error ? reason.message : "Не удалось открыть заметку");
          setDetails(null);
        }
      } finally {
        if (sequence === loadSequenceRef.current) setLoading(false);
      }
    },
    [invoke, refreshNotes, updateUrl],
  );

  useEffect(() => {
    void (async () => {
      try {
        const all = await refreshNotes();
        const fromUrl = noteIdFromSearch(search);
        if (fromUrl !== null) await loadNote(fromUrl, false);
        else if (all.length > 0) await loadNote(all[0]?.note.id ?? "", true);
        else setLoading(false);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить заметки");
        setLoading(false);
      }
    })();
    // Начальная загрузка выполняется один раз; последующие переходы идут через select/openResource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const selectNote = async (id: string) => {
    if (id === selectedIdRef.current) {
      setSidebarOpen(false);
      return;
    }
    await saveNow();
    if (dirtyRef.current) {
      setError("Сначала исправьте ошибку сохранения текущей заметки");
      return;
    }
    await loadNote(id);
  };

  const handledSearchRef = useRef(search);
  useEffect(() => {
    if (handledSearchRef.current === search) return;
    handledSearchRef.current = search;
    const id = noteIdFromSearch(search);
    if (id === null || id === selectedIdRef.current) return;
    void (async () => {
      await saveNow();
      if (!dirtyRef.current) await loadNote(id, true);
    })();
  }, [loadNote, saveNow, search]);

  const createNote = async (parentId: string | null) => {
    await saveNow();
    if (dirtyRef.current) return;
    setBusy(true);
    setError(null);
    const previousKey = createKeyRef.current;
    const createKey =
      previousKey !== null && previousKey.parentId === parentId
        ? previousKey.key
        : newIdempotencyKey("note-create");
    // Ключ живёт до успеха: retry той же операции не создаёт второй заметки.
    createKeyRef.current = { key: createKey, parentId };
    try {
      const next = await invokeNotes<NoteDetails>(
        invoke,
        NOTES_COMMAND_IDS.create,
        {
          parentId,
          title: "Без названия",
          contentMarkdown: "",
        },
        { idempotencyKey: createKey },
      );
      createKeyRef.current = null;
      await refreshNotes();
      await loadNote(next.view.note.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать заметку");
    } finally {
      setBusy(false);
    }
  };

  const moveNote = async (id: string, parentId: string | null, position?: number) => {
    const item = items.find((candidate) => candidate.note.id === id);
    if (item === undefined) return;
    if (selectedIdRef.current === id) {
      await saveNow();
      if (dirtyRef.current) return;
    }
    setBusy(true);
    try {
      const result = await invokeNotes<NoteMoveResult>(invoke, NOTES_COMMAND_IDS.move, {
        id,
        expectedVersion: selectedIdRef.current === id ? versionRef.current : item.note.version,
        parentId,
        ...(position === undefined ? {} : { position }),
      });
      const remaining = await refreshNotes();
      // Полная перезагрузка открытой заметки стёрла бы черновик. Вместо неё
      // синхронизируем version/позицию из ответа move, включая reorder соседа.
      const moved = new Map(
        [result.note, ...result.affectedNotes].map((note) => [note.id, note] as const),
      );
      setDetails((current) => {
        if (current === null) return current;
        const updated = moved.get(current.view.note.id);
        if (updated === undefined) return current;
        const note = { ...current.view.note, ...updated };
        return {
          ...current,
          view: { ...current.view, note },
          ancestors: ancestorsOf(note, remaining),
        };
      });
      const currentAffected = moved.get(selectedIdRef.current ?? "");
      if (currentAffected !== undefined) versionRef.current = currentAffected.version;
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось переместить заметку");
    } finally {
      setBusy(false);
    }
  };

  const deleteNote = async (view: NoteView) => {
    setBusy(true);
    try {
      const preview = await invokeNotes<NoteSubtree>(invoke, NOTES_QUERY_IDS.subtree, {
        id: view.note.id,
      });
      if (
        !window.confirm(
          `Удалить ветку «${view.note.title}»? Страниц: ${preview.noteCount}, вложений: ${preview.attachmentCount}. Действие необратимо.`,
        )
      ) {
        return;
      }
      if (selectedIdRef.current === view.note.id) {
        await saveNow();
        if (dirtyRef.current) return;
      }
      const result = await invokeNotes<NoteDeleteResult>(invoke, NOTES_COMMAND_IDS.delete, {
        id: view.note.id,
        expectedVersion:
          selectedIdRef.current === view.note.id ? versionRef.current : view.note.version,
        expectedDescendants: preview.noteCount,
        confirm: true,
      });
      const remaining = await refreshNotes();
      const deletedIds = new Set(
        result.deleted ? result.deletedNotes.map((note) => note.id) : [view.note.id],
      );
      if (selectedIdRef.current !== null && deletedIds.has(selectedIdRef.current)) {
        dirtyRef.current = false;
        if (remaining.length > 0) await loadNote(remaining[0]?.note.id ?? "");
        else {
          selectedIdRef.current = null;
          setSelectedId(null);
          setDetails(null);
          updateUrl(null);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить заметку");
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = async () => {
    if (details === null) return;
    const id = details.view.note.id;
    try {
      const { view } = await invokeNotes<{ view: NoteView }>(
        invoke,
        NOTES_COMMAND_IDS.favoriteSet,
        {
          id,
          favorite: !details.view.favorite,
        },
      );
      setDetails((current) => (current?.view.note.id === id ? { ...current, view } : current));
      await refreshNotes();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить избранное");
    }
  };

  const changeTitle = (value: string) => {
    setTitle(value);
    titleRef.current = value;
    draftRevisionRef.current += 1;
    dirtyRef.current = true;
    setSaveState("dirty");
    scheduleSave();
  };

  const changeMarkdown = (value: string) => {
    setEditorValue(value);
    contentRef.current = cacheRef.current.toCanonical(value);
    draftRevisionRef.current += 1;
    dirtyRef.current = true;
    setSaveState("dirty");
    scheduleSave();
  };

  const uploadImageNow = async (file: File): Promise<string> => {
    const noteId = selectedIdRef.current;
    if (noteId === null) throw new Error("Сначала создайте заметку");
    const mimeType = file.type as NoteAttachmentMimeType;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
      throw new Error("Поддерживаются только PNG, JPEG, GIF и WebP");
    }
    const contentBase64 = await fileToBase64(file);
    const fingerprint = snapshotIdempotencyKey("note-attachment-payload", {
      noteId,
      mimeType,
      contentBase64,
    });
    const previous = uploadKeyRef.current;
    const key =
      previous?.fingerprint === fingerprint ? previous.key : newIdempotencyKey("note-attachment");
    uploadKeyRef.current = { key, fingerprint };
    const result = await invokeNotes<{ attachment: NoteAttachmentDescriptor }>(
      invoke,
      NOTES_COMMAND_IDS.attachmentCreate,
      { noteId, mimeType, contentBase64 },
      { idempotencyKey: key },
    );
    // Только неопределённый результат получает retry с тем же ключом. Два
    // намеренных успешных upload — разные операции и разные ключи.
    uploadKeyRef.current = null;
    const dataUrl = cacheRef.current.set(result.attachment.id, mimeType, contentBase64);
    attachmentsRef.current = [...attachmentsRef.current, result.attachment];
    setDetails((current) =>
      current?.view.note.id === noteId
        ? { ...current, attachments: attachmentsRef.current }
        : current,
    );
    return dataUrl;
  };

  const uploadImage = (file: File): Promise<string> => {
    const next = uploadChainRef.current.then(
      () => uploadImageNow(file),
      () => uploadImageNow(file),
    );
    uploadChainRef.current = next.catch(() => undefined);
    return next;
  };

  const deleteAttachmentExplicitly = async (attachment: NoteAttachmentDescriptor) => {
    if (!window.confirm(`Удалить вложение ${attachment.id}? Действие необратимо.`)) return;
    await saveNow();
    if (dirtyRef.current) return;
    setBusy(true);
    try {
      await invokeNotes(invoke, NOTES_COMMAND_IDS.attachmentDelete, {
        id: attachment.id,
        confirm: true,
      });
      attachmentsRef.current = attachmentsRef.current.filter(
        (candidate) => candidate.id !== attachment.id,
      );
      setDetails((current) =>
        current?.view.note.id === attachment.noteId
          ? { ...current, attachments: attachmentsRef.current }
          : current,
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить вложение");
    } finally {
      setBusy(false);
    }
  };

  const exportNote = async () => {
    if (selectedIdRef.current === null) return;
    await saveNow();
    if (dirtyRef.current) return;
    try {
      const result = await invokeNotes<NoteExport>(invoke, NOTES_QUERY_IDS.export, {
        id: selectedIdRef.current,
      });
      downloadMarkdownExport(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось экспортировать заметку");
    }
  };

  const reloadConflict = async () => {
    if (selectedIdRef.current === null) return;
    downloadMarkdownExport({
      fileName: "draft.md",
      mediaType: "text/markdown",
      content: `# ${titleRef.current}\n\n${contentRef.current}`,
    });
    await loadNote(selectedIdRef.current, false);
  };

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (searchText.trim().length === 0) {
      setSearchResults(null);
      return;
    }
    try {
      const result = await invokeNotes<NoteSearchPage>(invoke, NOTES_QUERY_IDS.search, {
        text: searchText.trim(),
        limit: 50,
        offset: 0,
      });
      setSearchResults(result);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Поиск не выполнен");
    }
  };

  const referencedAttachmentIds = new Set(
    extractAttachmentIds(cacheRef.current.toCanonical(editorValue)),
  );

  const visibleItems =
    filter === "favorite"
      ? items.filter((item) => item.favorite)
      : filter === "recent"
        ? items
            .filter((item) => item.lastOpenedAt !== null)
            .sort((left, right) =>
              (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? ""),
            )
            .slice(0, 20)
        : items;

  const descendantsForSelected = new Set<string>();
  if (selectedId !== null) {
    descendantsForSelected.add(selectedId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of items) {
        if (
          item.note.parentId !== null &&
          descendantsForSelected.has(item.note.parentId) &&
          !descendantsForSelected.has(item.note.id)
        ) {
          descendantsForSelected.add(item.note.id);
          changed = true;
        }
      }
    }
  }

  const openLinkedResource = (ref: ResourceRef) => {
    if (openResource) openResource(ref);
  };

  return (
    <div
      data-testid="notes-view"
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row"
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2 lg:hidden">
        <button
          type="button"
          aria-label="Открыть дерево заметок"
          onClick={() => setSidebarOpen(true)}
          className={buttonClass}
        >
          <Menu aria-hidden="true" className="size-4" /> Страницы
        </button>
        <span className="text-sm font-medium">Заметки</span>
        <button
          type="button"
          aria-label="Создать заметку"
          disabled={busy}
          onClick={() => void createNote(null)}
          className={buttonClass}
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </header>

      <aside
        aria-label="Навигация по заметкам"
        className={`${sidebarOpen ? "fixed inset-0 z-40 flex bg-background" : "hidden"} min-h-0 shrink-0 flex-col border-r border-border lg:static lg:flex lg:w-72`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <h1 className="text-base font-semibold">Заметки</h1>
          <button
            type="button"
            aria-label="Закрыть дерево заметок"
            onClick={() => setSidebarOpen(false)}
            className={`${buttonClass} lg:hidden`}
          >
            <PanelLeftClose aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            data-note-create-top
            disabled={busy}
            onClick={() => void createNote(null)}
            className={`${buttonClass} hidden lg:inline-flex`}
          >
            <Plus aria-hidden="true" className="size-4" /> Создать
          </button>
        </div>
        <form
          onSubmit={(event) => void runSearch(event)}
          className="flex gap-1 border-b border-border p-2"
        >
          <input
            aria-label="Поиск заметок"
            data-testid="note-search-input"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Поиск…"
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button type="submit" aria-label="Найти" className={buttonClass}>
            <Search aria-hidden="true" className="size-4" />
          </button>
        </form>
        <div
          className="flex gap-1 border-b border-border p-2"
          role="group"
          aria-label="Фильтр страниц"
        >
          {(["tree", "favorite", "recent"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              data-note-filter={value}
              onClick={() => {
                setFilter(value);
                setSearchResults(null);
              }}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${filter === value ? "bg-accent" : "hover:bg-accent/50"}`}
            >
              {value === "tree" ? "Дерево" : value === "favorite" ? "Избранное" : "Недавние"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {searchResults !== null ? (
            <section aria-label="Результаты поиска">
              <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted-foreground">
                <span>Найдено: {searchResults.items.length}</span>
                <button type="button" onClick={() => setSearchResults(null)} className="underline">
                  Сбросить
                </button>
              </div>
              <ul className="m-0 list-none p-0">
                {searchResults.items.map((hit) => (
                  <li key={hit.noteId}>
                    <button
                      type="button"
                      data-note-search-result={hit.noteId}
                      onClick={() => void selectNote(hit.noteId)}
                      className="w-full rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block truncate text-sm font-medium">{hit.title}</span>
                      <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                        {hit.excerpt}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <NoteTree
              items={visibleItems}
              flat={filter === "recent"}
              selectedId={selectedId}
              onSelect={(id) => void selectNote(id)}
              onCreate={(parentId) => void createNote(parentId)}
              onMove={(id, parentId, position) => void moveNote(id, parentId, position)}
              onDelete={(view) => void deleteNote(view)}
            />
          )}
        </div>
      </aside>

      <section
        aria-label="Редактор заметки"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      >
        {details === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <FileText aria-hidden="true" className="size-10 text-muted-foreground" />
            <h2 className="text-lg font-medium">
              {loading ? "Загрузка заметок…" : "Создайте первую страницу"}
            </h2>
            {!loading ? (
              <button
                type="button"
                data-testid="note-create-empty"
                disabled={busy}
                onClick={() => void createNote(null)}
                className={buttonClass}
              >
                <Plus aria-hidden="true" className="size-4" /> Новая заметка
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="border-b border-border px-4 py-3 sm:px-6">
              <nav
                aria-label="Путь к странице"
                className="mb-2 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground"
              >
                {details.ancestors.map((ancestor) => (
                  <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void selectNote(ancestor.id)}
                      className="truncate hover:underline"
                    >
                      {ancestor.title}
                    </button>
                    <span aria-hidden="true">/</span>
                  </span>
                ))}
                <span className="truncate">{details.view.note.title}</span>
              </nav>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="note-favorite"
                    aria-pressed={details.view.favorite}
                    onClick={() => void toggleFavorite()}
                    className={buttonClass}
                  >
                    <Star
                      aria-hidden="true"
                      className={`size-4 ${details.view.favorite ? "fill-current text-amber-500" : ""}`}
                    />
                    {details.view.favorite ? "В избранном" : "В избранное"}
                  </button>
                  <button
                    type="button"
                    data-testid="note-export"
                    onClick={() => void exportNote()}
                    className={buttonClass}
                  >
                    <Download aria-hidden="true" className="size-4" /> Экспорт
                  </button>
                  <button
                    type="button"
                    data-note-delete-current
                    disabled={busy}
                    onClick={() => void deleteNote(details.view)}
                    className={`${buttonClass} text-destructive`}
                  >
                    <Trash2 aria-hidden="true" className="size-4" /> Удалить
                  </button>
                </div>
                <span
                  data-testid="note-save-state"
                  role="status"
                  className={`flex items-center gap-1 text-xs ${saveState === "error" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  <Save aria-hidden="true" className="size-3.5" />
                  {saveState === "saving"
                    ? "Сохраняем…"
                    : saveState === "dirty"
                      ? "Есть изменения"
                      : saveState === "error"
                        ? "Ошибка сохранения"
                        : "Сохранено"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label htmlFor="note-parent" className="text-xs text-muted-foreground">
                  Родительская страница
                </label>
                <select
                  id="note-parent"
                  data-testid="note-parent"
                  value={details.view.note.parentId ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    void moveNote(details.view.note.id, event.target.value || null)
                  }
                  className={`${inputClass} max-w-full`}
                >
                  <option value="">Корневой уровень</option>
                  {items
                    .filter((item) => !descendantsForSelected.has(item.note.id))
                    .map((item) => (
                      <option key={item.note.id} value={item.note.id}>
                        {item.note.title}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            {error ? (
              <div
                role="alert"
                className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-6"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{error}</span>
                  {conflict ? (
                    <button
                      type="button"
                      data-testid="note-conflict-reload"
                      onClick={() => void reloadConflict()}
                      className="underline"
                    >
                      Скачать черновик и загрузить серверную версию
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-note-save-retry
                      onClick={() => void saveNow()}
                      className="underline"
                    >
                      Повторить
                    </button>
                  )}
                </div>
              </div>
            ) : null}

            <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6">
              <input
                aria-label="Заголовок заметки"
                data-testid="note-title"
                value={title}
                disabled={loading || busy}
                onChange={(event) => changeTitle(event.target.value)}
                placeholder="Без названия"
                className="mb-4 w-full rounded-md border border-transparent bg-transparent px-2 py-2 text-2xl font-semibold tracking-tight focus-visible:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-3xl"
              />
              <MarkdownNoteEditor
                noteId={details.view.note.id}
                value={editorValue}
                onChange={changeMarkdown}
                onUploadImage={uploadImage}
                readOnly={loading || busy}
                ariaLabel="Содержимое заметки"
              />
            </div>
            {details.attachments.length > 0 ? (
              <section
                aria-labelledby="note-attachments-title"
                className="mx-auto w-full max-w-5xl border-t border-border px-4 py-3 sm:px-6"
              >
                <h2 id="note-attachments-title" className="mb-2 text-sm font-medium">
                  Вложения
                </h2>
                <p className="mb-2 text-xs text-muted-foreground">
                  Неиспользуемые файлы можно удалить вручную после сохранения.
                </p>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {details.attachments.map((attachment, index) => {
                    const inUse = referencedAttachmentIds.has(attachment.id);
                    return (
                      <li
                        key={attachment.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate text-muted-foreground">
                          Изображение {index + 1} · {attachment.mimeType} ·{" "}
                          {Math.ceil(attachment.sizeBytes / 1024)} KiB
                        </span>
                        <button
                          type="button"
                          data-note-attachment-delete={attachment.id}
                          aria-label={`Удалить вложение ${attachment.id}`}
                          disabled={busy || inUse}
                          title={
                            inUse ? "Сначала удалите изображение из текста" : "Удалить вложение"
                          }
                          onClick={() => void deleteAttachmentExplicitly(attachment)}
                          className="rounded-md px-2 py-1 text-destructive hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                        >
                          Удалить
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            <div className="mx-auto w-full max-w-5xl pb-6">
              <NoteLinks
                noteId={details.view.note.id}
                invoke={invoke}
                openResource={openResource ? openLinkedResource : undefined}
              />
            </div>
          </>
        )}
        {error && details === null ? (
          <p role="alert" className="p-4 text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
