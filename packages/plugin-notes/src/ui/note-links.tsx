"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2, Plus, Unlink } from "lucide-react";
import type { ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type { ResolvedNoteLink } from "../model.ts";
import { formatNoteRef } from "../resources.ts";
import { invokeNotes, type NotesUiRendererProps } from "./runtime.ts";

interface NoteLinksProps extends Pick<NotesUiRendererProps, "invoke" | "openResource"> {
  readonly noteId: string;
}

interface LinkTarget {
  readonly ref: ResourceRef;
  readonly title: string;
}

interface LinksOutput {
  readonly items: readonly ResolvedNoteLink[];
}

function taskTargets(value: unknown, resourceType: "task" | "project"): LinkTarget[] {
  if (typeof value !== "object" || value === null || !("items" in value)) {
    return [];
  }
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("title" in item)) {
      return [];
    }
    const { id, title } = item as { id: unknown; title: unknown };
    return typeof id === "string" && typeof title === "string"
      ? [{ ref: `kanbaner.tasks:${resourceType}:${id}`, title }]
      : [];
  });
}

export function NoteLinks({ noteId, invoke, openResource }: NoteLinksProps) {
  const [items, setItems] = useState<readonly ResolvedNoteLink[]>([]);
  const [targets, setTargets] = useState<readonly LinkTarget[]>([]);
  const [targetRef, setTargetRef] = useState("");
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

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      invokeNotes<unknown>(invoke, "kanbaner.tasks.project.list", { limit: 100, offset: 0 }),
      invokeNotes<unknown>(invoke, "kanbaner.tasks.task.list", { limit: 100, offset: 0 }),
    ]).then(([projects, tasks]) => {
      if (!active) return;
      const next = [
        ...(projects.status === "fulfilled" ? taskTargets(projects.value, "project") : []),
        ...(tasks.status === "fulfilled" ? taskTargets(tasks.value, "task") : []),
      ];
      setTargets(next);
      if (next.length > 0) {
        setTargetRef((current) => current || next[0]?.ref || "");
      }
    });
    return () => {
      active = false;
    };
  }, [invoke]);

  const link = async (ref: string) => {
    setBusy(true);
    setError(null);
    try {
      await invokeNotes(invoke, NOTES_COMMAND_IDS.link, { noteId, targetRef: ref });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать связь");
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (otherRef: ResourceRef) => {
    setBusy(true);
    try {
      await invokeNotes(invoke, NOTES_COMMAND_IDS.unlink, { noteId, targetRef: otherRef });
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
                  onClick={() => void unlink(otherRef)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Unlink aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-1">
        <input
          aria-label="ResourceRef для связи"
          data-note-link-target
          list={`note-link-targets-${noteId}`}
          value={targetRef}
          onChange={(event) => setTargetRef(event.target.value)}
          placeholder="plugin:type:id"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <datalist id={`note-link-targets-${noteId}`}>
          {targets.map((target) => (
            <option key={target.ref} value={target.ref}>
              {target.title}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          data-testid="note-link-add"
          aria-label="Добавить связь"
          disabled={busy || targetRef.trim().length === 0}
          onClick={() => void link(targetRef.trim())}
          className="inline-flex size-8 items-center justify-center rounded-md border border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
