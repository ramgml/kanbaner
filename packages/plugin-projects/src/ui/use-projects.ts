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

const PROJECT_LIMIT = 200;

export interface ProjectsData {
  readonly projects: readonly Project[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/** Читает проекты через публичный `kanbaner.tasks.project.list`. */
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
      const data = await invokeJson<ProjectListOutput>(invoke, TASKS_QUERY_IDS.projectList, {
        limit: PROJECT_LIMIT,
        offset: 0,
      } as unknown as JsonValue);

      if (sequenceRef.current === sequence) {
        setProjects(data.items);
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
