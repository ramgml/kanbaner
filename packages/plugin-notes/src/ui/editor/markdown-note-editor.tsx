"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, ComponentType, ReactNode } from "react";
import { filterSuggestionItems } from "@blocknote/core";
import type { SuggestionMenuOptions } from "@blocknote/core";
import { ru } from "@blocknote/core/locales";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";

import {
  markdownToEditorBlocks,
  sanitizeImageAlt,
  sanitizeImageUrl,
  serializeBlockNoteMarkdown,
} from "./blocknote-markdown.ts";
import {
  imageUploadErrorMessage,
  isImageFile,
  markdownDocumentsEqual,
  sanitizeImageSource,
  validateLinkHref,
} from "./editor-markdown.ts";
import { NOTE_EDITOR_STYLES } from "./editor-styles.ts";
import { noteEditorSchema } from "./note-editor-schema.tsx";

export interface MarkdownNoteEditorProps {
  /** Смена ID означает новый документ и пересоздание редактора. */
  readonly noteId: string;
  /** Текущий Markdown документа. */
  readonly value: string;
  /** Вызывается только при пользовательских изменениях. */
  readonly onChange: (markdown: string) => void;
  /** Загружает изображение и возвращает URL для image-узла. */
  readonly onUploadImage: (file: File) => Promise<string>;
  /**
   * Загруженные вложения: канонический `attachment://id` → data URL.
   *
   * Применяются императивно к блокам после загрузки, чтобы Markdown оставался
   * коротким и не проходил через micromark с мегабайтными data URL.
   */
  readonly attachmentUrls?: ReadonlyMap<string, string>;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

const DEFAULT_ARIA_LABEL = "Текст заметки";
const EMPTY_URLS: ReadonlyMap<string, string> = new Map();
const PREVIEW_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const FILE_BLOCK_TYPES = new Set(["image", "file", "audio", "video"]);

interface EditorBlockLike {
  readonly id: string;
  readonly type: string;
  readonly props?: unknown;
  readonly children?: readonly EditorBlockLike[];
}

/**
 * Убирает из сериализации только pending/пустые file-блоки. Остальной
 * документ, включая текст, набранный во время загрузки, публикуется как есть.
 */
function stripUploadArtifacts(
  blocks: readonly EditorBlockLike[],
  pending: ReadonlySet<string>,
): EditorBlockLike[] {
  return blocks
    .filter((block) => {
      if (pending.has(block.id)) return false;
      if (!FILE_BLOCK_TYPES.has(block.type)) return true;
      const props = block.props as { readonly url?: string } | undefined;
      const url = props?.url ?? "";
      return url.length > 0 && url !== PREVIEW_PLACEHOLDER;
    })
    .map((block) => ({ ...block, children: stripUploadArtifacts(block.children ?? [], pending) }));
}

interface EditorViewProps {
  readonly editor: object;
  readonly theme: "light" | "dark";
  readonly editable: boolean;
  readonly className: string;
  readonly slashMenu: boolean;
  readonly onChange: () => void;
  readonly children?: ReactNode;
}

interface InlineNodeLike {
  readonly type?: string;
  readonly props?: { readonly url?: string; readonly [key: string]: unknown };
  readonly content?: unknown;
}

interface BlockLike {
  readonly id: string;
  readonly type: string;
  readonly props?: { readonly url?: string; readonly [key: string]: unknown };
  readonly content?: unknown;
  readonly children?: readonly BlockLike[];
}

interface InlineResolution {
  readonly content: unknown;
  readonly changed: boolean;
}

const INLINE_IMAGE_TYPES = new Set(["inlineImage", "linkedImage"]);

/**
 * Рекурсивно заменяет `attachment://` URL в inline-контенте одного блока,
 * включая ячейки таблицы (`tableContent.rows[].cells[]`).
 */
function resolveInlineAttachmentUrls(
  content: unknown,
  urls: ReadonlyMap<string, string>,
): InlineResolution {
  if (Array.isArray(content)) {
    let changed = false;
    const nextContent = content.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const node = item as InlineNodeLike;
      let nextNode = node;
      let nodeChanged = false;

      if (
        node.type !== undefined &&
        INLINE_IMAGE_TYPES.has(node.type) &&
        typeof node.props?.url === "string"
      ) {
        const replacement = urls.get(node.props.url);
        if (replacement !== undefined) {
          nextNode = { ...nextNode, props: { ...node.props, url: replacement } };
          nodeChanged = true;
        }
      }

      const nested = resolveInlineAttachmentUrls(nextNode.content, urls);
      if (nested.changed) {
        nextNode = { ...nextNode, content: nested.content };
        nodeChanged = true;
      }

      if (!nodeChanged) return item;
      changed = true;
      return nextNode;
    });

    return changed ? { content: nextContent, changed: true } : { content, changed: false };
  }

  if (typeof content === "object" && content !== null) {
    const record = content as {
      readonly rows?: unknown;
      readonly content?: unknown;
      readonly cells?: unknown;
    };

    if (Array.isArray(record.rows)) {
      let changed = false;
      const rows = record.rows.map((row) => {
        if (typeof row !== "object" || row === null) return row;
        const cells = (row as { readonly cells?: unknown }).cells;
        if (!Array.isArray(cells)) return row;

        let rowChanged = false;
        const nextCells = cells.map((cell) => {
          const resolved = resolveInlineAttachmentUrls(cell, urls);
          if (resolved.changed) rowChanged = true;
          return resolved.content;
        });

        if (!rowChanged) return row;
        changed = true;
        return { ...(row as Record<string, unknown>), cells: nextCells };
      });

      return changed
        ? { content: { ...(content as object), rows }, changed: true }
        : { content, changed: false };
    }

    // Ячейка таблицы — объект `tableCell` со своим inline-контентом.
    if (Array.isArray(record.content)) {
      const resolved = resolveInlineAttachmentUrls(record.content, urls);
      return resolved.changed
        ? { content: { ...(content as object), content: resolved.content }, changed: true }
        : { content, changed: false };
    }
  }

  return { content, changed: false };
}

/**
 * Приводит сериализованный Markdown к каноническому виду для сравнения с
 * baseline. Замена строковая: вызывать micromark на мегабайтных data URL
 * ради проверки «изменился ли документ» нельзя.
 */
function canonicalizeAttachmentUrls(markdown: string, urls: ReadonlyMap<string, string>): string {
  let result = markdown;
  for (const [canonical, dataUrl] of urls) {
    result = result.replaceAll(dataUrl, canonical);
  }
  return result;
}

/** Ищет канонические `attachment://` URL, которые ещё не заменены data URL. */
function hasUnresolvedAttachmentUrls(
  editor: ReturnType<typeof useCreateBlockNote>,
  urls: ReadonlyMap<string, string>,
): boolean {
  const contentHasUnresolved = (content: unknown): boolean => {
    if (Array.isArray(content)) {
      return content.some((item) => {
        if (typeof item !== "object" || item === null) return false;
        const node = item as InlineNodeLike;
        if (
          node.type !== undefined &&
          INLINE_IMAGE_TYPES.has(node.type) &&
          typeof node.props?.url === "string" &&
          urls.has(node.props.url)
        ) {
          return true;
        }
        return contentHasUnresolved(node.content);
      });
    }

    if (typeof content === "object" && content !== null) {
      const record = content as {
        readonly rows?: unknown;
        readonly content?: unknown;
        readonly cells?: unknown;
      };
      if (Array.isArray(record.rows)) {
        return record.rows.some((row) => {
          if (typeof row !== "object" || row === null) return false;
          const cells = (row as { readonly cells?: unknown }).cells;
          return Array.isArray(cells) && cells.some(contentHasUnresolved);
        });
      }
      return Array.isArray(record.content) && contentHasUnresolved(record.content);
    }

    return false;
  };

  const visit = (block: BlockLike): boolean => {
    if (
      block.type === "image" &&
      typeof block.props?.url === "string" &&
      urls.has(block.props.url)
    ) {
      return true;
    }
    if (contentHasUnresolved(block.content)) return true;
    return (block.children ?? []).some(visit);
  };

  return (editor.document as unknown as readonly BlockLike[]).some(visit);
}

interface TransactionMetaLike {
  setMeta: (key: string, value: unknown) => unknown;
}

/**
 * Выполняет программное изменение документа вне undo-истории.
 *
 * Загрузка страницы, внешнее значение и подстановка вложений — не действия
 * пользователя: Ctrl+Z после открытия не должен очищать или ломать документ.
 */
function withoutHistory(editor: ReturnType<typeof useCreateBlockNote>, action: () => void): void {
  editor.transact((transaction: TransactionMetaLike) => {
    transaction.setMeta("addToHistory", false);
    action();
  });
}

/**
 * Подставляет загруженные data URL в image-блоки и inline image.
 *
 * Документ и внешнее значение остаются каноническими: замена выполняется
 * поверх готового дерева блоков и не запускает autosave.
 */
function applyAttachmentUrls(
  editor: ReturnType<typeof useCreateBlockNote>,
  urls: ReadonlyMap<string, string>,
): void {
  if (urls.size === 0) return;

  withoutHistory(editor, () => {
    const visit = (block: BlockLike): void => {
      let nextProps: BlockLike["props"] | undefined;
      if (block.type === "image" && typeof block.props?.url === "string") {
        const replacement = urls.get(block.props.url);
        if (replacement !== undefined) {
          nextProps = { ...block.props, url: replacement };
        }
      }

      const inline = resolveInlineAttachmentUrls(block.content, urls);
      if (nextProps !== undefined || inline.changed) {
        const update = {
          ...(nextProps === undefined ? {} : { props: nextProps }),
          ...(inline.changed ? { content: inline.content } : {}),
        };
        editor.updateBlock(
          block as unknown as Parameters<typeof editor.updateBlock>[0],
          update as unknown as Parameters<typeof editor.updateBlock>[1],
        );
      }

      for (const child of block.children ?? []) visit(child);
    };

    for (const block of editor.document as unknown as readonly BlockLike[]) visit(block);
  });
}
// BlockNote 0.54 не проходит exactOptionalPropertyTypes в собственных generic-типах.
// Приведение ограничено props представления; editor остаётся строго типизирован выше.
const EditorView = BlockNoteView as unknown as ComponentType<EditorViewProps>;

function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** BlockNote редактирует дерево блоков, но наружу уходит канонический Markdown. */
export function MarkdownNoteEditor({
  noteId,
  value,
  onChange,
  onUploadImage,
  attachmentUrls,
  readOnly = false,
  disabled = false,
  ariaLabel = DEFAULT_ARIA_LABEL,
}: MarkdownNoteEditorProps) {
  const editorId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const uploadRef = useRef(onUploadImage);
  const attachmentUrlsRef = useRef<ReadonlyMap<string, string>>(attachmentUrls ?? EMPTY_URLS);
  const lastEmittedRef = useRef(value);
  const appliedValueRef = useRef(value);
  const initializedRef = useRef(false);
  const suppressChangeRef = useRef(false);
  const mountedRef = useRef(true);
  const lockedRef = useRef(readOnly || disabled);
  const editorRef = useRef<ReturnType<typeof useCreateBlockNote> | null>(null);
  const pendingUploadsRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  const locked = readOnly || disabled;
  /** Документ ProseMirror последнего опубликованного/применённого состояния. */
  const lastDocRef = useRef<unknown>(null);

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    uploadRef.current = onUploadImage;
    attachmentUrlsRef.current = attachmentUrls ?? EMPTY_URLS;
    lockedRef.current = locked;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const refresh = () => setTheme(currentTheme());
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    refresh();
    return () => observer.disconnect();
  }, []);

  /** Общая загрузка с проверкой результата; ошибки обрабатывает вызывающий flow. */
  const uploadImageSource = useCallback(async (file: File): Promise<string> => {
    if (!isImageFile(file)) throw new Error("Можно загрузить только файл изображения.");
    const source = sanitizeImageSource(await uploadRef.current(file));
    if (source === null) throw new Error("Некорректный адрес изображения.");
    return sanitizeImageUrl(source);
  }, []);

  /**
   * Встроенный upload BlockNote (paste/drop/slash) получает blockId. Пока
   * загрузка не завершена, блок помечается pending: его пустой/placeholder URL
   * не публикуется в onChange и не запускает автосохранение. При ошибке блок
   * удаляется, при успехе возвращается атомарный update с url и безопасным alt.
   */
  const uploadThroughBlockNote = useCallback(
    async (
      file: File,
      blockId?: string,
    ): Promise<string | { readonly props: { readonly url: string; readonly name: string } }> => {
      const activeEditor = editorRef.current;
      if (blockId !== undefined) pendingUploadsRef.current.add(blockId);

      const cleanup = () => {
        if (activeEditor === null || blockId === undefined) return;
        window.setTimeout(() => {
          pendingUploadsRef.current.delete(blockId);
          try {
            if (activeEditor.getBlock(blockId) !== undefined) {
              activeEditor.removeBlocks([blockId]);
            }
          } catch {
            // Блок уже удалён или редактор размонтирован.
          }
        }, 0);
      };
      const fail = (reason: unknown): string => {
        cleanup();
        if (mountedRef.current && editorRef.current === activeEditor) {
          setError(imageUploadErrorMessage(reason));
        }
        return PREVIEW_PLACEHOLDER;
      };

      if (activeEditor === null || lockedRef.current) {
        return fail(new Error("Редактор недоступен для загрузки изображения."));
      }

      setError(null);
      setUploading(true);
      try {
        const source = await uploadImageSource(file);
        if (!mountedRef.current || lockedRef.current || editorRef.current !== activeEditor) {
          return fail(new Error("Заметка закрыта до завершения загрузки."));
        }
        if (blockId !== undefined) pendingUploadsRef.current.delete(blockId);
        return { props: { url: source, name: sanitizeImageAlt(file.name) } };
      } catch (reason) {
        return fail(reason);
      } finally {
        if (mountedRef.current) setUploading(false);
      }
    },
    [uploadImageSource],
  );

  const uploadFile = useCallback(
    (file: File, blockId?: string) => uploadThroughBlockNote(file, blockId),
    [uploadThroughBlockNote],
  );

  const editor = useCreateBlockNote(
    {
      schema: noteEditorSchema,
      dictionary: ru,
      uploadFile,
      links: {
        isValidLink: (href) => validateLinkHref(href).ok,
      },
      domAttributes: {
        editor: {
          id: editorId,
          class: "kne-content",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": ariaLabel,
          spellcheck: "true",
          autocapitalize: "sentences",
        },
      },
    },
    [noteId, editorId],
  );
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    let cancelled = false;
    initializedRef.current = false;
    suppressChangeRef.current = false;
    appliedValueRef.current = valueRef.current;
    // Новый экземпляр BlockNote требует сброса внешнего состояния редактора;
    // это синхронизация с imperative-объектом, а не derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(false);
    setError(null);
    setUploading(false);

    try {
      withoutHistory(editor, () => {
        editor.replaceBlocks(editor.document, markdownToEditorBlocks(editor, valueRef.current));
        applyAttachmentUrls(editor, attachmentUrlsRef.current);
      });
      lastEmittedRef.current = canonicalizeAttachmentUrls(
        serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy()),
        attachmentUrlsRef.current,
      );
      lastDocRef.current = editor.prosemirrorState.doc;
      initializedRef.current = true;
      if (!cancelled) setReady(true);
    } catch {
      if (!cancelled) setError("Не удалось создать редактор заметки.");
    }

    return () => {
      cancelled = true;
    };
  }, [editor]);

  useEffect(() => {
    const content = rootRef.current?.querySelector<HTMLElement>(".bn-editor");
    content?.setAttribute("aria-readonly", String(readOnly));
    content?.setAttribute("aria-disabled", String(disabled));
  }, [disabled, readOnly, ready]);

  useEffect(() => {
    if (!ready || markdownDocumentsEqual(value, appliedValueRef.current)) return;

    const current = serializeBlockNoteMarkdown(
      editor.blocksToMarkdownLossy(
        stripUploadArtifacts(editor.document, pendingUploadsRef.current) as unknown as Parameters<
          typeof editor.blocksToMarkdownLossy
        >[0],
      ),
    );
    const canonicalCurrent = canonicalizeAttachmentUrls(current, attachmentUrlsRef.current);
    if (markdownDocumentsEqual(value, current) || markdownDocumentsEqual(value, canonicalCurrent)) {
      lastEmittedRef.current = canonicalCurrent;
      appliedValueRef.current = value;
      return;
    }

    suppressChangeRef.current = true;
    try {
      withoutHistory(editor, () => {
        editor.replaceBlocks(editor.document, markdownToEditorBlocks(editor, value));
        applyAttachmentUrls(editor, attachmentUrlsRef.current);
      });
      lastEmittedRef.current = canonicalizeAttachmentUrls(
        serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy()),
        attachmentUrlsRef.current,
      );
      lastDocRef.current = editor.prosemirrorState.doc;
      appliedValueRef.current = value;
    } catch {
      queueMicrotask(() => setError("Не удалось обновить содержимое редактора."));
    } finally {
      suppressChangeRef.current = false;
    }
  }, [editor, ready, value]);

  /** Догруженные вложения подставляются поверх блоков без изменения Markdown. */
  useEffect(() => {
    if (!ready || attachmentUrls === undefined || attachmentUrls.size === 0) return;
    suppressChangeRef.current = true;
    try {
      applyAttachmentUrls(editor, attachmentUrls);
      lastDocRef.current = editor.prosemirrorState.doc;
    } finally {
      suppressChangeRef.current = false;
    }
  }, [attachmentUrls, editor, ready]);

  /**
   * Пункт «Картинка» в slash/side menu открывает существующий file input,
   * который использует общий uploadFiles-флоу. Документ не меняется:
   * SuggestionMenuWrapper сам удаляет trigger/query, а при отмене picker
   * не остаётся ни пустого image-блока, ни нового параграфа.
   */
  const pickImage = useCallback(() => {
    if (lockedRef.current) return;
    const input = imageInputRef.current;
    if (input === null || input.disabled) return;
    input.click();
  }, []);

  const shouldOpenSlashMenu = useCallback<NonNullable<SuggestionMenuOptions["shouldOpen"]>>(
    (state) => !state.selection.$from.parent.type.isInGroup("tableContent"),
    [],
  );

  const getSlashMenuItems = useCallback(
    async (query: string) => {
      const items = getDefaultReactSlashMenuItems(
        // BlockNote 0.54 не выводит generic кастомной схемы в собственных
        // типах; приведение ограничено фабрикой пунктов меню.
        editor as unknown as Parameters<typeof getDefaultReactSlashMenuItems>[0],
      );
      return filterSuggestionItems(
        items.map((item) =>
          (item as { readonly key?: string }).key === "image"
            ? { ...item, onItemClick: pickImage }
            : item,
        ),
        query,
      );
    },
    [editor, pickImage],
  );

  const uploadFiles = useCallback(
    async (files: readonly File[]) => {
      const images = files.filter(isImageFile);
      if (locked || images.length === 0) {
        if (files.length > 0 && images.length === 0) {
          setError("Можно загрузить только файл изображения.");
        }
        return;
      }

      const activeEditor = editor;
      setError(null);
      setUploading(true);
      try {
        for (const file of images) {
          const source = await uploadImageSource(file);
          if (!mountedRef.current || lockedRef.current || editorRef.current !== activeEditor) {
            return;
          }

          const imageBlock = {
            type: "image",
            props: { url: source, name: sanitizeImageAlt(file.name) },
          } as const;
          let reference: { readonly id: string } | undefined;
          try {
            reference = activeEditor.getTextCursorPosition().block;
          } catch {
            reference = activeEditor.document.at(-1);
          }
          if (reference === undefined) throw new Error("Не удалось создать блок изображения.");

          const current = activeEditor.getBlock(reference.id);
          if (current?.type === "paragraph" && current.content.length === 0) {
            activeEditor.setTextCursorPosition(
              activeEditor.updateBlock(current, imageBlock),
              "end",
            );
          } else {
            const [inserted] = activeEditor.insertBlocks([imageBlock], reference, "after");
            if (inserted !== undefined) activeEditor.setTextCursorPosition(inserted, "end");
          }
        }
      } catch (reason) {
        if (mountedRef.current) setError(imageUploadErrorMessage(reason));
      } finally {
        if (mountedRef.current) setUploading(false);
      }
    },
    [editor, locked, uploadImageSource],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) void uploadFiles(files);
  };

  return (
    <div
      ref={rootRef}
      className="kanbaner-note-editor"
      data-note-id={noteId}
      data-read-only={readOnly ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      data-ready={ready ? "true" : "false"}
    >
      <style data-kanbaner-note-editor-styles="true">{NOTE_EDITOR_STYLES}</style>
      <div className="kne-surface">
        <EditorView
          editor={editor}
          theme={theme}
          editable={!locked}
          className="kne-blocknote"
          slashMenu={false}
          onChange={() => {
            if (!initializedRef.current || suppressChangeRef.current) return;
            // setEditable и прочие технические события эмитят change без
            // изменения документа: сериализовать мегабайтные data URL вложений
            // ради них нельзя.
            const doc = editor.prosemirrorState.doc;
            if (lastDocRef.current === doc) return;
            lastDocRef.current = doc;

            // Undo/redo может вернуть снимок с каноническим attachment:// URL.
            // Возвращаем data URL вне истории; повторный change подавлен.
            const urls = attachmentUrlsRef.current;
            if (urls.size > 0 && hasUnresolvedAttachmentUrls(editor, urls)) {
              suppressChangeRef.current = true;
              try {
                applyAttachmentUrls(editor, urls);
              } finally {
                suppressChangeRef.current = false;
              }
              lastDocRef.current = editor.prosemirrorState.doc;
            }

            const blocks = stripUploadArtifacts(editor.document, pendingUploadsRef.current);
            const markdown = serializeBlockNoteMarkdown(
              editor.blocksToMarkdownLossy(
                blocks as unknown as Parameters<typeof editor.blocksToMarkdownLossy>[0],
              ),
            );
            const canonical = canonicalizeAttachmentUrls(markdown, urls);
            if (markdownDocumentsEqual(canonical, lastEmittedRef.current)) {
              lastEmittedRef.current = canonical;
              return;
            }
            lastEmittedRef.current = canonical;
            onChangeRef.current(markdown);
          }}
        >
          {locked ? null : (
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={getSlashMenuItems}
              shouldOpen={shouldOpenSlashMenu}
            />
          )}
        </EditorView>
        {!ready && error === null ? (
          <p className="kne-loading" role="status">
            Загрузка редактора…
          </p>
        ) : null}
      </div>
      <div className="kne-status" role="status" aria-live="polite">
        {uploading ? <span>Загрузка изображения…</span> : null}
        {error !== null ? (
          <span className="kne-status-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <input
        ref={imageInputRef}
        data-testid="note-image-input"
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        disabled={locked}
        hidden
        onChange={handleFileChange}
      />
    </div>
  );
}
