"use client";

import type { ReactNode } from "react";

import type { UiContributionKind, UiSlotId } from "@kanbaner/plugin-sdk";

import { useUiContributions, useUiOperationInvoker } from "../../ui/provider";
import type { RegisteredUiContribution } from "../../ui/registry";
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
}: {
  readonly contribution: RegisteredUiContribution;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
}) {
  const Component = contribution.render;
  const invoke = useUiOperationInvoker();

  return (
    <Component
      contribution={contribution}
      invoke={invoke}
      pathname={pathname}
      search={search}
      replaceSearch={replaceSearch}
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
          />
        </ContributionBoundary>
      ))}
    </div>
  );
}
