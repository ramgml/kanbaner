/* eslint-disable jsx-a11y/role-supports-aria-props -- переключатель состояния
   реализован на настоящих <a>; aria-pressed отражает выбранный вид. */

"use client";

import { LayoutGrid, List } from "lucide-react";

import { KANBAN_ROUTE, TASK_LIST_ROUTE, type ProjectRoute } from "../metadata.ts";
import { rememberProjectView } from "./workspace.ts";

export interface ViewToggleProps {
  readonly route: ProjectRoute;
  /** Текущая query string вместе с ведущим `?`; переносится между видами. */
  readonly search: string;
  /** Префикс `data-testid`; внутри модала отличается от header-переключателя. */
  readonly testIdPrefix?: string;
  readonly label?: string;
}

function withSearch(pathname: string, search: string): string {
  const normalized = search.startsWith("?") ? search : search.length === 0 ? "" : `?${search}`;

  return `${pathname}${normalized}`;
}

const toggleClass = (active: boolean): string =>
  `inline-flex min-h-10 items-center gap-1.5 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8 ${
    active ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"
  }`;

/**
 * Переключатель `Список / Канбан`.
 *
 * Реальные `<a>` нужны и в заголовке, и внутри нативного `<dialog>`: ссылка
 * остаётся фокусируемой и кликабельной, когда фон модала inert. `aria-pressed`
 * выставлен в обоих состояниях, `aria-current` сохраняет семантику страницы.
 */
export function ViewToggle({
  route,
  search,
  testIdPrefix = "project-view",
  label = "Представление проекта",
}: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      <a
        href={withSearch(TASK_LIST_ROUTE, search)}
        data-testid={`${testIdPrefix}-list`}
        aria-current={route === TASK_LIST_ROUTE ? "page" : undefined}
        aria-pressed={route === TASK_LIST_ROUTE}
        onClick={() => {
          rememberProjectView(TASK_LIST_ROUTE);
        }}
        className={toggleClass(route === TASK_LIST_ROUTE)}
      >
        <List aria-hidden="true" className="size-3.5" />
        Список
      </a>
      <a
        href={withSearch(KANBAN_ROUTE, search)}
        data-testid={`${testIdPrefix}-kanban`}
        aria-current={route === KANBAN_ROUTE ? "page" : undefined}
        aria-pressed={route === KANBAN_ROUTE}
        onClick={() => {
          rememberProjectView(KANBAN_ROUTE);
        }}
        className={`${toggleClass(route === KANBAN_ROUTE)} border-l border-border`}
      >
        <LayoutGrid aria-hidden="true" className="size-3.5" />
        Канбан
      </a>
    </div>
  );
}
