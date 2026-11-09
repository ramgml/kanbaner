"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_QUERY_IDS,
  type Project,
  type ProjectListOutput,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker } from "@kanbaner/task-ui";

import { errorMessage, invokeJson } from "./operations.ts";
import { useProjectsRevision } from "./workspace.ts";

/** Контракт `project.list` ограничивает limit значением 200. */
const PROJECT_PAGE_SIZE = 200;
/** Защита от бесконечной пагинации при ошибочном nextOffset. */
const MAX_PROJECT_PAGES = 100;

export interface ProjectsData {
  readonly projects: readonly Project[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/**
 * Читает проекты через публичный `kanbaner.tasks.project.list`.
 *
 * Contract разрешает не больше 200 записей на страницу, поэтому список
 * догружается по `nextOffset`. Иначе проект за первой страницей выглядел бы
 * удалённым, а sidebar не смог бы открыть созданный 201-й проект.
 */
export function useProjectsData(invoke: UiOperationInvoker): ProjectsData {
  const revision = useProjectsRevision();
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const sequence = sequenceRef.current + 1;

    sequenceRef.current = sequence;
    setLoading(true);

    try {
      const collected: Project[] = [];
      const seen = new Set<string>();
      let offset = 0;

      for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
        const data = await invokeJson<ProjectListOutput>(invoke, TASKS_QUERY_IDS.projectList, {
          limit: PROJECT_PAGE_SIZE,
          offset,
        } as unknown as JsonValue);

        if (sequenceRef.current !== sequence) {
          return;
        }

        for (const project of data.items) {
          if (!seen.has(project.id)) {
            seen.add(project.id);
            collected.push(project);
          }
        }

        if (
          data.nextOffset === null ||
          data.items.length === 0 ||
          data.nextOffset <= offset ||
          data.nextOffset >= data.total
        ) {
          break;
        }

        offset = data.nextOffset;
      }

      if (sequenceRef.current === sequence) {
        setProjects(collected);
        setError(null);
      }
    } catch (loadError) {
      if (sequenceRef.current === sequence) {
        setError(errorMessage(loadError));
      }
    } finally {
      if (sequenceRef.current === sequence) {
        setLoading(false);
      }
    }
  }, [invoke]);

  useEffect(() => {
    // Первичная и повторная загрузка после мутаций: setLoading внутри reload
    // синхронный, поэтому правило отключено осознанно.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload, revision]);

  return { projects, loading, error, reload };
}
