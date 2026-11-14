"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2, Unlink } from "lucide-react";
import type { ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type { ResolvedNoteLink } from "../model.ts";
import { formatNoteRef } from "../resources.ts";
import { NoteLinkPicker } from "./note-link-picker.tsx";
import { invokeNotes, type NotesUiRendererProps } from "./runtime.ts";

interface NoteLinksProps extends Pick<NotesUiRendererProps, "invoke" | "openResource"> {
  readonly noteId: string;
}

interface LinksOutput {
  readonly items: readonly ResolvedNoteLink[];
}

export function NoteLinks({ noteId, invoke, openResource }: NoteLinksProps) {
  const [items, setItems] = useState<readonly ResolvedNoteLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteRef = formatNoteRef(noteId);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeNotes<LinksOutput>(invoke, NOTES_QUERY_IDS.links, {
        ref: noteRef,
      });
      setItems(result.items);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить связи");
    }
  }, [invoke, noteRef]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const link = async (targetRef: ResourceRef): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await invokeNotes(invoke, NOTES_COMMAND_IDS.link, { noteId, targetRef });
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать связь");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (sourceRef: ResourceRef, targetRef: ResourceRef) => {
    setBusy(true);
    setError(null);
    try {
      // Удаляем именно фактическую связь, не разворачивая направление:
      // заметка может быть как source, так и target.
      await invokeNotes(invoke, NOTES_COMMAND_IDS.unlink, { noteId, sourceRef, targetRef });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить связь");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="note-links-title" className="border-t border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="note-links-title" className="flex items-center gap-2 text-sm font-medium">
          <Link2 aria-hidden="true" className="size-4" /> Связи
        </h2>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="my-2 text-xs text-muted-foreground">
          Свяжите страницу с задачей или проектом.
        </p>
      ) : (
        <ul className="m-0 mb-2 flex list-none flex-col gap-1 p-0">
          {items.map((item) => {
            const sourceIsNote = item.link.sourceRef === noteRef;
            const otherRef = sourceIsNote ? item.link.targetRef : item.link.sourceRef;
            const descriptor = sourceIsNote ? item.target : item.source;
            return (
              <li
                key={`${item.link.sourceRef}:${item.link.targetRef}`}
                className="flex items-center gap-1"
              >
                {openResource && descriptor !== null ? (
                  <button
                    type="button"
                    data-note-open-link={otherRef}
                    onClick={() => openResource(otherRef)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                    <span className="truncate">{descriptor.title}</span>
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate px-1.5 text-xs text-muted-foreground">
                    {descriptor?.title ?? "Ресурс недоступен"}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Удалить связь с ${descriptor?.title ?? otherRef}`}
                  disabled={busy}
                  onClick={() => void unlink(item.link.sourceRef, item.link.targetRef)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Unlink aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <NoteLinkPicker noteId={noteId} invoke={invoke} busy={busy} onLink={link} />
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
