"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { NoteTitleField } from "./note-title-field.tsx";
import { NoteTree } from "./note-tree.tsx";
import { useNoteSidebarResizer } from "./use-note-sidebar-resizer.ts";
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

interface MoveRequest {
  readonly id: string;
  readonly parentId: string | null;
  readonly position?: number;
}

interface MoveFailure {
  readonly message: string;
  /** Повтор именно move; `null`, если повтор бессмысленен (цикл, глубина). */
  readonly retry: MoveRequest | null;
}

type NotesViewProps = NotesUiRendererProps;

const inputClass =
  "rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const EMPTY_ATTACHMENT_URLS: ReadonlyMap<string, string> = new Map();

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
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<MoveFailure | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState(false);
  const [title, setTitle] = useState("");
  const [editorValue, setEditorValue] = useState("");
  const [canonicalContent, setCanonicalContent] = useState("");
  const [attachmentUrls, setAttachmentUrls] =
    useState<ReadonlyMap<string, string>>(EMPTY_ATTACHMENT_URLS);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<NoteSearchPage | null>(null);
  const sidebarResizer = useNoteSidebarResizer();

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
  const itemsRef = useRef<readonly NoteView[]>([]);
  /** Монотонное поколение list-запросов: старый ответ не перетирает новый. */
  const listGenerationRef = useRef(0);
  /** Единый счётчик мутаций: busy не снимается, пока хоть одна в полёте. */
  const pendingCountRef = useRef(0);
  const moveChainRef = useRef<Promise<void>>(Promise.resolve());
  const activeMovesRef = useRef(0);
  /** Номер актуальной move-операции: старый результат не перетирает новый. */
  const moveAttemptRef = useRef(0);

  const beginPending = useCallback(() => {
    pendingCountRef.current += 1;
    setPendingCount(pendingCountRef.current);
  }, []);

  const endPending = useCallback(() => {
    pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
    setPendingCount(pendingCountRef.current);
  }, []);

  const busy = pendingCount > 0;

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
    const generation = ++listGenerationRef.current;
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
    // Ответ старого запроса мог прийти после нового: применяем только
    // актуальное поколение, иначе дерево и itemsRef откатятся назад.
    if (generation === listGenerationRef.current) {
      itemsRef.current = all;
      setItems(all);
    }
    return all;
  }, [invoke]);

  /**
   * Перечитывает открытую страницу после конфликта move.
   *
   * Обновляет view/ancestors/version и список, но не трогает локальные title,
   * editorValue, dirty и saveState: черновик не должен потеряться.
   */
  const resyncOpenNote = useCallback(async (): Promise<void> => {
    const id = selectedIdRef.current;
    if (id === null) return;
    const [next] = await Promise.all([
      invokeNotes<NoteDetails>(invoke, NOTES_QUERY_IDS.get, { id }),
      refreshNotes(),
    ]);
    if (selectedIdRef.current !== id) return;
    versionRef.current = next.view.note.version;
    setDetails((current) =>
      current?.view.note.id === id ? { ...next, attachments: current.attachments } : current,
    );
  }, [invoke, refreshNotes]);

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
        await refreshNotes().catch(() => undefined);
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

  /**
   * Догружает содержимое вложений после показа заметки.
   *
   * Заметка и Markdown отображаются сразу после `note.get`; data URL
   * подставляются в готовое дерево блоков. Sequence и selectedId защищают
   * быстрые переходы от применения вложений чужой страницы.
   */
  const loadAttachmentUrls = useCallback(
    async (
      id: string,
      attachments: readonly NoteAttachmentDescriptor[],
      sequence: number,
    ): Promise<void> => {
      if (attachments.length === 0) return;
      try {
        const loaded = await Promise.all(
          attachments.map(async (attachment) => {
            const result = await invokeNotes<{ attachment: NoteAttachment }>(
              invoke,
              NOTES_QUERY_IDS.attachmentGet,
              { id: attachment.id },
            );
            return result.attachment;
          }),
        );
        if (sequence !== loadSequenceRef.current || selectedIdRef.current !== id) return;

        const cache = cacheRef.current;
        for (const attachment of loaded) cache.add(attachment);
        setAttachmentUrls(cache.toEditorUrls());
      } catch (reason) {
        if (sequence === loadSequenceRef.current && selectedIdRef.current === id) {
          setError(
            reason instanceof Error
              ? `Не удалось загрузить вложения: ${reason.message}`
              : "Не удалось загрузить вложения",
          );
        }
      }
    },
    [invoke],
  );

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
        if (sequence !== loadSequenceRef.current) return;

        // Ввод, начавшийся после старта get, не затирается: для той же заметки
        // сохраняем черновик, dirty и состояние сохранения.
        const draftChanged = draftRevisionRef.current !== revisionAtStart;
        const keepDraft = sameNoteAtStart && draftChanged;

        // Новая страница получает пустой cache: содержимое вложений приедет
        // отдельно и не задержит первый рендер редактора. Для той же страницы
        // cache сохраняется, иначе уже показанные data URL нельзя канонизировать.
        if (!sameNoteAtStart) {
          cacheRef.current = new AttachmentUrlCache();
          setAttachmentUrls(EMPTY_ATTACHMENT_URLS);
        }
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
          setCanonicalContent(next.view.note.contentMarkdown);
          // Редактор парсит короткий canonical Markdown, а не мегабайтные
          // data URL вложений; они подставляются после загрузки.
          setEditorValue(next.view.note.contentMarkdown);
          setSaveState("idle");
        }
        setSearchResults(null);
        if (updateLocation) updateUrl(id);
        setSidebarOpen(false);
        setLoading(false);
        void loadAttachmentUrls(id, next.attachments, sequence);
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
    [invoke, loadAttachmentUrls, refreshNotes, updateUrl],
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
    beginPending();
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
      endPending();
    }
  };

  const performMove = async (request: MoveRequest): Promise<void> => {
    const attempt = ++moveAttemptRef.current;
    try {
      // Открытая страница может быть affected sibling: сохраняем её черновик
      // до любого move, иначе ответ домена перезапишет более новую версию.
      await saveNow();
      if (dirtyRef.current) {
        if (attempt === moveAttemptRef.current) {
          setMoveError({
            message: "Сначала исправьте ошибку сохранения текущей заметки",
            retry: request,
          });
        }
        return;
      }

      const item = itemsRef.current.find((candidate) => candidate.note.id === request.id);
      if (item === undefined) return;

      const result = await invokeNotes<NoteMoveResult>(invoke, NOTES_COMMAND_IDS.move, {
        id: request.id,
        expectedVersion:
          selectedIdRef.current === request.id ? versionRef.current : item.note.version,
        parentId: request.parentId,
        ...(request.position === undefined ? {} : { position: request.position }),
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
      if (attempt === moveAttemptRef.current) setMoveError(null);
    } catch (reason) {
      // Старая операция не должна перетирать ошибку новой.
      if (attempt !== moveAttemptRef.current) return;
      if (reason instanceof NotesUiError && reason.code === "VERSION_CONFLICT") {
        setMoveError({
          message:
            "Страница изменилась другой операцией. Данные перечитаны — повторите перемещение.",
          retry: request,
        });
        // Перечитываем список/details/version, не трогая черновик.
        await resyncOpenNote().catch(() => undefined);
        return;
      }
      const domainReason = reason instanceof NotesUiError ? reason.reason : undefined;
      if (domainReason === "NOTE_TREE_CYCLE") {
        setMoveError({
          message: "Нельзя переместить страницу внутрь её собственной ветки",
          retry: null,
        });
        return;
      }
      if (domainReason === "NOTE_TREE_TOO_DEEP") {
        setMoveError({ message: "Превышена максимальная глубина дерева", retry: null });
        return;
      }
      setMoveError({
        message: reason instanceof Error ? reason.message : "Не удалось переместить заметку",
        retry: reason instanceof NotesUiError && reason.retryable ? request : null,
      });
    }
  };

  /**
   * Ставит move в очередь.
   *
   * invoke + refresh + affected updates выполняются строго последовательно:
   * вторая операция не может прочитать старое дерево и перезаписать версии
   * первой. На всё время очереди DnD/reorder/root drop отключены.
   */
  const moveNote = (id: string, parentId: string | null, position?: number): Promise<void> => {
    const request: MoveRequest =
      position === undefined ? { id, parentId } : { id, parentId, position };
    activeMovesRef.current += 1;
    setMovePending(true);
    beginPending();
    const next = moveChainRef.current.then(() => performMove(request));
    moveChainRef.current = next.catch(() => undefined);
    const settle = () => {
      activeMovesRef.current -= 1;
      endPending();
      if (activeMovesRef.current === 0) setMovePending(false);
    };
    void next.then(settle, settle);
    return next;
  };

  const retryMove = () => {
    const request = moveError?.retry ?? null;
    if (request === null) return;
    void moveNote(request.id, request.parentId, request.position);
  };

  const deleteNote = async (view: NoteView) => {
    beginPending();
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
      endPending();
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
    const canonical = cacheRef.current.toCanonical(value);
    setEditorValue(value);
    contentRef.current = canonical;
    setCanonicalContent(canonical);
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
    beginPending();
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
      endPending();
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

  /**
   * Ссылки на вложения считаются по каноническому Markdown, а не по значению
   * редактора с data URL. Иначе каждый рендер парсит мегабайтные вложения.
   */
  const referencedAttachmentIds = useMemo(
    () => new Set(extractAttachmentIds(canonicalContent)),
    [canonicalContent],
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
      ref={sidebarResizer.containerRef}
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
        id="notes-sidebar"
        style={sidebarResizer.asideStyle}
        className={`${sidebarOpen ? "fixed inset-0 z-40 flex bg-background" : "hidden"} min-h-0 shrink-0 flex-col border-r border-border lg:relative lg:flex lg:[width:var(--note-sidebar-width)]`}
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
              positionItems={items}
              flat={filter === "recent"}
              movePending={movePending}
              actionsDisabled={busy}
              selectedId={selectedId}
              onSelect={(id) => void selectNote(id)}
              onCreate={(parentId) => void createNote(parentId)}
              onMove={(id, parentId, position) => void moveNote(id, parentId, position)}
              onDelete={(view) => void deleteNote(view)}
            />
          )}
        </div>
        <div
          {...sidebarResizer.separatorProps}
          aria-label="Ширина дерева заметок"
          aria-controls="notes-sidebar"
          title="Потяните за границу, используйте стрелки, Home/End; двойной клик сбрасывает ширину"
          className="group absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none select-none focus-visible:bg-accent/60 focus-visible:outline-none lg:block"
        >
          <span
            aria-hidden="true"
            data-note-sidebar-resizer-line
            className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
              sidebarResizer.dragging
                ? "bg-primary"
                : "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary"
            }`}
          />
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
                  disabled={busy || movePending}
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

            {moveError ? (
              <div
                role="alert"
                data-testid="note-move-error"
                className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-6"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{moveError.message}</span>
                  {moveError.retry === null ? null : (
                    <button
                      type="button"
                      data-testid="note-move-retry"
                      disabled={movePending}
                      onClick={retryMove}
                      className="underline disabled:opacity-50"
                    >
                      Повторить перемещение
                    </button>
                  )}
                </div>
              </div>
            ) : null}

            <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6">
              <NoteTitleField value={title} disabled={loading || busy} onChange={changeTitle} />
              <MarkdownNoteEditor
                noteId={details.view.note.id}
                value={editorValue}
                onChange={changeMarkdown}
                onUploadImage={uploadImage}
                attachmentUrls={attachmentUrls}
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
