"use client";

import { useSyncExternalStore } from "react";

import type { Project } from "@kanbaner/plugin-tasks/contract";

import type { ProjectRoute } from "../metadata.ts";

const LAST_PROJECT_KEY = "kanbaner.projects.lastProjectId";
const LAST_VIEW_KEY = "kanbaner.projects.lastView";

/** Breakpoint мобильного layout-а sidebar: 768 px и уже. */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)" as const;

export interface WorkspaceViewContext {
  readonly route: ProjectRoute;
  /** Активный проект представления; пустая строка — проект ещё не выбран. */
  readonly projectId: string;
  /** Текущая query string представления вместе с ведущим `?`. */
  readonly search: string;
  /** Применяет query string, сохраняя текущее представление. */
  readonly navigate: (search: string) => void;
}

let currentContext: WorkspaceViewContext | null = null;
const contextListeners = new Set<() => void>();

let projectsRevision = 0;
const revisionListeners = new Set<() => void>();

let projectCreateRequest = 0;
const projectCreateListeners = new Set<() => void>();

function emit(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ошибка наблюдателя не должна ломать остальные представления.
    }
  }
}

/** Регистрирует активное представление для sidebar и mobile sheet. */
export function registerWorkspaceView(context: WorkspaceViewContext): () => void {
  currentContext = context;
  emit(contextListeners);

  return () => {
    if (currentContext === context) {
      currentContext = null;
      emit(contextListeners);
    }
  };
}

export function getWorkspaceView(): WorkspaceViewContext | null {
  return currentContext;
}

export function subscribeWorkspaceView(listener: () => void): () => void {
  contextListeners.add(listener);

  return () => {
    contextListeners.delete(listener);
  };
}

export function useWorkspaceView(): WorkspaceViewContext | null {
  return useSyncExternalStore(subscribeWorkspaceView, getWorkspaceView, () => null);
}

/** Уведомляет все списки проектов о create/rename/delete. */
export function bumpProjectsRevision(): void {
  projectsRevision += 1;
  emit(revisionListeners);
}

export function getProjectsRevision(): number {
  return projectsRevision;
}

export function subscribeProjectsRevision(listener: () => void): () => void {
  revisionListeners.add(listener);

  return () => {
    revisionListeners.delete(listener);
  };
}

export function useProjectsRevision(): number {
  return useSyncExternalStore(subscribeProjectsRevision, getProjectsRevision, () => 0);
}

/**
 * Запрашивает открытие формы создания проекта.
 *
 * Команда не привязана к конкретному DOM-узлу: desktop sidebar и мобильный
 * bottom sheet сами решают, какой контейнер показать. Это убирает клик по
 * скрытой кнопке другого layout-а.
 */
export function requestProjectCreate(): void {
  projectCreateRequest += 1;
  emit(projectCreateListeners);
}

export function getProjectCreateRequest(): number {
  return projectCreateRequest;
}

export function subscribeProjectCreateRequest(listener: () => void): () => void {
  projectCreateListeners.add(listener);

  return () => {
    projectCreateListeners.delete(listener);
  };
}

export function useProjectCreateRequest(): number {
  return useSyncExternalStore(subscribeProjectCreateRequest, getProjectCreateRequest, () => 0);
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function rememberProject(projectId: string): void {
  if (projectId.length === 0) {
    return;
  }

  try {
    safeStorage()?.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Приватный режим может запрещать storage; выбор всё равно работает.
  }
}

export function readLastProjectId(): string | null {
  try {
    const value = safeStorage()?.getItem(LAST_PROJECT_KEY)?.trim() ?? "";

    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

export function rememberProjectView(route: ProjectRoute): void {
  try {
    safeStorage()?.setItem(LAST_VIEW_KEY, route);
  } catch {
    // См. rememberProject.
  }
}

export function readLastProjectView(): ProjectRoute | null {
  const value = safeStorage()?.getItem(LAST_VIEW_KEY);

  return value === "/view/kanban" || value === "/view/tasks" || value === "/view/projects"
    ? value
    : null;
}

/**
 * Выбирает проект для представления.
 *
 * Приоритет: явный ID из URL, последний валидный выбор, единственный проект.
 * Несколько проектов без сохранённого выбора означают явный выбор в sidebar,
 * а не агрегированную доску.
 */
export function resolveProjectId(
  projects: readonly Project[],
  requested: string,
  last: string | null,
): string | null {
  if (requested.length > 0 && projects.some((project) => project.id === requested)) {
    return requested;
  }

  if (last !== null && projects.some((project) => project.id === last)) {
    return last;
  }

  return projects.length === 1 ? (projects[0]?.id ?? null) : null;
}

export function searchWithProject(search: string, projectId: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  params.set("project", projectId);
  params.delete("task");

  const next = params.toString();

  return next.length === 0 ? "" : `?${next}`;
}
