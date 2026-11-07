"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import type { UiContribution } from "@kanbaner/plugin-sdk";

import { executePluginOperation, type UiOperationResult } from "../server/plugin-operations";
import { Button } from "../components/ui/button";
import { useUiRegistry } from "./provider";
import { type UiComponent } from "./plugin-api";

export interface SerializedUiContribution {
  readonly pluginId: string;
  readonly contribution: UiContribution;
}

function OperationPanel({ contribution }: { readonly contribution: RegisteredLike }) {
  const [result, setResult] = useState<UiOperationResult | null>(null);
  const [pending, startTransition] = useTransition();
  const operationId = contribution.contribution.commandId;

  const run = (): void => {
    if (operationId === undefined) {
      return;
    }

    startTransition(async () => {
      setResult(await executePluginOperation(operationId, {}));
    });
  };

  return (
    <section
      data-testid={`plugin-contribution-${contribution.contribution.id}`}
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h2 className="text-base font-semibold">
        {contribution.contribution.title ?? contribution.contribution.id}
      </h2>
      {contribution.contribution.description === undefined ? null : (
        <p className="mt-1 text-sm text-muted-foreground">
          {contribution.contribution.description}
        </p>
      )}
      {operationId === undefined ? null : (
        <div className="mt-3 flex flex-col gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            data-testid={`plugin-operation-${contribution.contribution.id}`}
            onClick={run}
          >
            {pending ? "Выполняется…" : "Выполнить операцию"}
          </Button>
          {result === null ? null : (
            <pre
              data-testid={`plugin-result-${contribution.contribution.id}`}
              className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs"
            >
              {JSON.stringify(result)}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

interface RegisteredLike {
  readonly contribution: UiContribution;
}

const GenericRenderer: UiComponent = ({ contribution }) => (
  <OperationPanel contribution={contribution} />
);

/**
 * Регистрирует серверные UI-метаданные через публичный реестр UI-контракта.
 *
 * Этот компонент не знает о fixture-плагине: он принимает только
 * сериализуемые декларации SDK и общий безопасный рендерер. Ошибка одного
 * вклада изолируется, shell продолжает работать.
 */
export function ServerUiContributions({
  contributions,
}: {
  readonly contributions: readonly SerializedUiContribution[];
}) {
  const registry = useUiRegistry();
  const stable = useMemo(() => contributions, [contributions]);

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    for (const record of stable) {
      try {
        cleanups.push(registry.register(record.pluginId, record.contribution, GenericRenderer));
      } catch {
        // Невалидный вклад не должен ронять shell и другие плагины.
      }
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [registry, stable]);

  return null;
}
