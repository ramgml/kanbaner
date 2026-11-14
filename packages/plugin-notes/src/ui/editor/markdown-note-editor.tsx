"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, ComponentType } from "react";
import { ru } from "@blocknote/core/locales";
import { useCreateBlockNote } from "@blocknote/react";
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
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

const DEFAULT_ARIA_LABEL = "Текст заметки";
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
  readonly onChange: () => void;
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

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    uploadRef.current = onUploadImage;
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
      editor.replaceBlocks(editor.document, markdownToEditorBlocks(editor, valueRef.current));
      lastEmittedRef.current = serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy());
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
    if (markdownDocumentsEqual(value, current)) {
      lastEmittedRef.current = current;
      appliedValueRef.current = value;
      return;
    }

    suppressChangeRef.current = true;
    try {
      editor.replaceBlocks(editor.document, markdownToEditorBlocks(editor, value));
      lastEmittedRef.current = serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy());
      appliedValueRef.current = value;
    } catch {
      queueMicrotask(() => setError("Не удалось обновить содержимое редактора."));
    } finally {
      suppressChangeRef.current = false;
    }
  }, [editor, ready, value]);

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
          onChange={() => {
            if (!initializedRef.current || suppressChangeRef.current) return;
            const blocks = stripUploadArtifacts(editor.document, pendingUploadsRef.current);
            const markdown = serializeBlockNoteMarkdown(
              editor.blocksToMarkdownLossy(
                blocks as unknown as Parameters<typeof editor.blocksToMarkdownLossy>[0],
              ),
            );
            if (markdownDocumentsEqual(markdown, lastEmittedRef.current)) return;
            lastEmittedRef.current = markdown;
            onChangeRef.current(markdown);
          }}
        />
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
