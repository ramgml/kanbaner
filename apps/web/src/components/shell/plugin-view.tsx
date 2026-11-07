"use client";

import { usePathname } from "next/navigation";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { useUiRoute } from "../../ui/provider";
import { ContributionBoundary } from "./contribution-boundary";
import { ContributionRenderer } from "./ui-slot";

export interface PluginViewProps {
  /** Явный путь нужен тестам; в приложении берётся из App Router. */
  readonly pathname?: string;
}

/**
 * Маршрутизация представлений плагинов.
 *
 * Вклад считается доступным, только если он зарегистрирован в слоте
 * `app.main` как `view`/`route` и его владелец не отключён.
 */
export function PluginView({ pathname }: PluginViewProps) {
  const currentPathname = usePathname() ?? "/";
  const contribution = useUiRoute(pathname ?? currentPathname);

  if (contribution === null) {
    return (
      <Empty data-testid="plugin-view-empty">
        <EmptyHeader>
          <EmptyTitle>Представление не найдено</EmptyTitle>
          <EmptyDescription>
            Для этого адреса нет активного UI-вклада. Проверьте plugin manager или вернитесь к
            обзору.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ContributionBoundary contribution={contribution}>
      <ContributionRenderer contribution={contribution} />
    </ContributionBoundary>
  );
}
