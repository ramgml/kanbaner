"use client";

import type { ReactNode } from "react";

import type { UiContributionKind, UiSlotId } from "@kanbaner/plugin-sdk";

import { useUiContributions } from "../../ui/provider";
import type { RegisteredUiContribution } from "../../ui/registry";
import { ContributionBoundary } from "./contribution-boundary";

export interface UiSlotProps {
  readonly slot: UiSlotId;
  readonly kinds?: readonly UiContributionKind[];
  readonly excludeKinds?: readonly UiContributionKind[];
  readonly onlyWithoutRoute?: boolean;
  readonly className?: string;
  readonly empty?: ReactNode;
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
}: {
  readonly contribution: RegisteredUiContribution;
}) {
  const Component = contribution.render;

  return <Component contribution={contribution} />;
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
          <ContributionRenderer contribution={contribution} />
        </ContributionBoundary>
      ))}
    </div>
  );
}
