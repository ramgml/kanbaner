"use client";

import { useCallback, type ReactNode } from "react";

import type { JsonObject, UiContributionKind, UiSlotId } from "@kanbaner/plugin-sdk";

import { useUiContributions, useUiOperationInvoker, useUiResourceOpener } from "../../ui/provider";
import type { RegisteredUiContribution, UiSlotRenderer } from "../../ui/registry";
import { ContributionBoundary } from "./contribution-boundary";

export interface UiSlotProps {
  readonly slot: UiSlotId;
  readonly kinds?: readonly UiContributionKind[];
  readonly excludeKinds?: readonly UiContributionKind[];
  readonly onlyWithoutRoute?: boolean;
  readonly className?: string;
  readonly empty?: ReactNode;
  /** Текущий pathname shell-а; передаётся каждому рендереру. */
  readonly pathname?: string | undefined;
  /** Текущая query string shell-а; передаётся каждому рендереру. */
  readonly search?: string | undefined;
  /** Обновление query string через App Router. */
  readonly replaceSearch?: ((search: string) => void) | undefined;
  /**
   * JSON-контекст вложенного слота.
   *
   * Передаётся каждому вкладу как `context`; родительский плагин не отдаёт
   * React-объекты или ссылки на свой DOM.
   */
  readonly context?: JsonObject | undefined;
}

function matchesFilters(
  contribution: RegisteredUiContribution,
  kinds: readonly UiContributionKind[] | undefined,
  excludeKinds: readonly UiContributionKind[] | undefined,
  onlyWithoutRoute: boolean | undefined,
): boolean {
  const metadata = contribution.contribution;

  if (kinds !== undefined && !kinds.includes(metadata.kind)) {
    return false;
  }

  if (excludeKinds !== undefined && excludeKinds.includes(metadata.kind)) {
    return false;
  }

  if (onlyWithoutRoute === true && metadata.route !== undefined) {
    return false;
  }

  return true;
}

export function ContributionRenderer({
  contribution,
  pathname,
  search,
  replaceSearch,
  context,
}: {
  readonly contribution: RegisteredUiContribution;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
  readonly context?: JsonObject | undefined;
}) {
  const Component = contribution.render;
  const invoke = useUiOperationInvoker();
  const openResource = useUiResourceOpener();
  /**
   * Outlet вложенного слота.
   *
   * Callback только создаёт React-элемент: `UiSlot` сам вызывает hooks и
   * оборачивает каждый вклад в отдельную границу ошибок. Поэтому hooks не
   * вызываются условно внутри callback-а.
   */
  const renderSlot = useCallback<UiSlotRenderer>(
    (slot, slotContext) => (
      <UiSlot
        slot={slot}
        context={slotContext}
        pathname={pathname}
        search={search}
        replaceSearch={replaceSearch}
      />
    ),
    [pathname, search, replaceSearch],
  );

  return (
    <Component
      contribution={contribution}
      invoke={invoke}
      pathname={pathname}
      search={search}
      replaceSearch={replaceSearch}
      context={context}
      openResource={openResource}
      renderSlot={renderSlot}
    />
  );
}

/**
 * Рендерит все доступные вклады слота. Каждый вклад изолирован собственной
 * границей ошибок и получает стабильный key по своему ID.
 */
export function UiSlot({
  slot,
  kinds,
  excludeKinds,
  onlyWithoutRoute,
  className,
  empty = null,
  pathname,
  search,
  replaceSearch,
  context,
}: UiSlotProps) {
  const contributions = useUiContributions(slot);
  const visible = contributions.filter((contribution) =>
    matchesFilters(contribution, kinds, excludeKinds, onlyWithoutRoute),
  );

  if (visible.length === 0) {
    return empty;
  }

  return (
    <div className={className} data-ui-slot={slot}>
      {visible.map((contribution) => (
        <ContributionBoundary key={contribution.contribution.id} contribution={contribution}>
          <ContributionRenderer
            contribution={contribution}
            pathname={pathname}
            search={search}
            replaceSearch={replaceSearch}
            context={context}
          />
        </ContributionBoundary>
      ))}
    </div>
  );
}
