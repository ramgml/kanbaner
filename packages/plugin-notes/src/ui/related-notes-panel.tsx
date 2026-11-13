"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Plus } from "lucide-react";
import type { ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type { NoteDetails, ResolvedNoteLink } from "../model.ts";
import { formatNoteRef, tryParseNoteRef } from "../resources.ts";
import { invokeNotes, type UiOperationInvoker } from "./runtime.ts";

interface RelatedNotesPanelProps {
  readonly resourceRef: ResourceRef;
  readonly invoke: UiOperationInvoker;
  readonly openResource?: ((ref: ResourceRef) => void) | undefined;
}

export function RelatedNotesPanel({ resourceRef, invoke, openResource }: RelatedNotesPanelProps) {
  const [items, setItems] = useState<readonly ResolvedNoteLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeNotes<{ items: readonly ResolvedNoteLink[] }>(
        invoke,
        NOTES_QUERY_IDS.links,
        { ref: resourceRef },
      );
      setItems(
        result.items.filter((item) =>
          [item.link.sourceRef, item.link.targetRef].some(
            (ref) => ref !== resourceRef && tryParseNoteRef(ref) !== null,
          ),
        ),
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить заметки");
    }
  }, [invoke, resourceRef]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const createLinkedNote = async () => {
    setBusy(true);
    try {
      const details = await invokeNotes<NoteDetails>(invoke, NOTES_COMMAND_IDS.create, {
        title: "Заметка к задаче",
      });
      const noteId = details.view.note.id;
      await invokeNotes(invoke, NOTES_COMMAND_IDS.link, { noteId, targetRef: resourceRef });
      await refresh();
      openResource?.(formatNoteRef(noteId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать заметку");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="related-notes-title" className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id="related-notes-title" className="flex items-center gap-2 text-sm font-medium">
          <FileText aria-hidden="true" className="size-4" /> Связанные заметки
        </h3>
        <button
          type="button"
          data-related-note-create={resourceRef}
          disabled={busy}
          onClick={() => void createLinkedNote()}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus aria-hidden="true" className="size-3.5" /> Создать
        </button>
      </div>
      {items.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">Связанных заметок пока нет.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {items.map((item) => {
            const otherRef =
              item.link.sourceRef === resourceRef ? item.link.targetRef : item.link.sourceRef;
            const descriptor = item.link.sourceRef === resourceRef ? item.target : item.source;
            return (
              <li key={otherRef}>
                <button
                  type="button"
                  data-related-note-open={otherRef}
                  onClick={() => openResource?.(otherRef)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FileText aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{descriptor?.title ?? "Заметка недоступна"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
