"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_QUERY_IDS,
  type ProjectSummary,
  type ProjectSummaryOutput,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker } from "@kanbaner/task-ui";

import { errorMessage, invokeJson } from "./operations.ts";

export interface ProjectSummaryState {
  readonly summary: ProjectSummary | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/** Читает точную сводку одного проекта через публичный запрос. */
export function useProjectSummary(
  invoke: UiOperationInvoker,
  projectId: string,
  revision: number,
): ProjectSummaryState {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [loading, setLoading] = useState(projectId.length > 0);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const sequence = sequenceRef.current + 1;

    sequenceRef.current = sequence;

    if (projectId.length === 0) {
      setSummary(null);
      setLoading(false);
      setError(null);

      return;
    }

    setLoading(true);

    try {
      const data = await invokeJson<ProjectSummaryOutput>(invoke, TASKS_QUERY_IDS.projectSummary, {
        projectId,
        limit: 1,
        offset: 0,
      } as unknown as JsonValue);

      if (sequenceRef.current === sequence) {
        setSummary(data.items.find((item) => item.project.id === projectId) ?? null);
        setError(null);
      }
    } catch (loadError) {
      if (sequenceRef.current === sequence) {
        setSummary(null);
        setError(errorMessage(loadError));
      }
    } finally {
      if (sequenceRef.current === sequence) {
        setLoading(false);
      }
    }
  }, [invoke, projectId]);

  useEffect(() => {
    // Первичная и повторная загрузка после мутаций: setLoading внутри reload
    // синхронный, поэтому правило отключено осознанно.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload, revision]);

  return { summary, loading, error, reload };
}
