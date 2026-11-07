"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { useUiRoute } from "../../ui/provider";
import { ContributionBoundary } from "./contribution-boundary";
import { ContributionRenderer } from "./ui-slot";

export interface PluginViewProps {
  /** Явный путь нужен тестам; в приложении берётся из App Router. */
  readonly pathname?: string;
  /** Явная query string нужна тестам; иначе берётся из App Router. */
  readonly search?: string;
  /** Явный writer нужен тестам; иначе используется App Router. */
  readonly replaceSearch?: (search: string) => void;
}

/**
 * Маршрутизация представлений плагинов.
 *
 * Вклад считается доступным, только если он зарегистрирован в слоте
 * `app.main` как `view`/`route` и его владелец не отключён.
 */
export function PluginView({ pathname, search, replaceSearch }: PluginViewProps) {
  const routerPathname = usePathname() ?? "/";
  const routerSearch = useSearchParams()?.toString() ?? "";
  const router = useRouter();
  const currentPathname = pathname ?? routerPathname;
  const currentSearch = search ?? routerSearch;
  const routerReplaceSearch = useCallback(
    (nextSearch: string) => {
      router.replace(`${currentPathname}${nextSearch}`, { scroll: false });
    },
    [currentPathname, router],
  );
  const contribution = useUiRoute(currentPathname);

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
      <ContributionRenderer
        contribution={contribution}
        pathname={currentPathname}
        search={currentSearch}
        replaceSearch={replaceSearch ?? routerReplaceSearch}
      />
    </ContributionBoundary>
  );
}
