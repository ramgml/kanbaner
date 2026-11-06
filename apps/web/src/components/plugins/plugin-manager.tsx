"use client";

import { useState, useTransition } from "react";

import { Blocks, RefreshCw, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import type { PluginManagerActionResult, PluginManagerState } from "../../lib/plugin-manager-types";
import { refreshPluginsAction, setPluginEnabledAction } from "../../server/plugin-actions";
import { PluginCard } from "./plugin-card";

function formatUtc(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function SafeModePanel({ state }: { readonly state: PluginManagerState }) {
  if (!state.safeMode) {
    return null;
  }

  return (
    <Alert variant="destructive" data-testid="safe-mode-panel">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>Safe mode</AlertTitle>
      <AlertDescription>
        <p>
          Проблемные плагины не активированы, остальные разделы и плагины продолжают работать.
          Причина и стабильный код диагностики перечислены ниже.
        </p>
        {state.problems.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {state.problems.map((problem, index) => (
              <li
                key={`${problem.pluginId ?? "runtime"}-${problem.code}-${String(index)}`}
                className="rounded-md border border-destructive/20 bg-background/60 px-3 py-2 text-xs"
              >
                <p className="font-medium">
                  {problem.pluginId ?? "runtime"} · {problem.code} · {problem.status}
                </p>
                <p className="mt-1 text-muted-foreground">{problem.message}</p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{problem.source}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>Runtime сообщил safe mode без дополнительных проблем в снимке состояния.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export interface PluginManagerProps {
  readonly initialState: PluginManagerState;
}

/**
 * Экран управления плагинами.
 *
 * Действия идут через server action и публичный lifecycle runtime:
 * `stop()` → новый runtime с обновлённым `disabledPlugins` → `start()`.
 * Страница не перезагружается целиком: server action возвращает новый
 * безопасный снимок и инвалидирует RSC-дерево.
 */
export function PluginManager({ initialState }: PluginManagerProps) {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const activeCount = state.plugins.filter((plugin) => plugin.activated).length;
  const configuredCount = state.plugins.filter((plugin) => plugin.configuredEnabled).length;

  function applyResult(result: PluginManagerActionResult): void {
    if (result.ok && result.state !== null) {
      setState(result.state);
      setError(null);
      return;
    }

    setError(result.error?.message ?? "Не удалось изменить состояние плагина");
  }

  function toggle(pluginId: string, enabled: boolean): void {
    setPendingId(pluginId);
    setError(null);

    startTransition(async () => {
      try {
        applyResult(await setPluginEnabledAction(pluginId, enabled));
      } finally {
        setPendingId(null);
      }
    });
  }

  function refresh(): void {
    setPendingId("__refresh__");
    setError(null);

    startTransition(async () => {
      try {
        applyResult(await refreshPluginsAction());
      } finally {
        setPendingId(null);
      }
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Blocks aria-hidden="true" className="size-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">Плагины</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Состояние runtime, версии, зависимости, диагностика и safe mode.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={refresh}
          disabled={isPending}
          className="w-full sm:w-auto"
        >
          {pendingId === "__refresh__" ? (
            <Spinner aria-label="Обновление" data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          Обновить
        </Button>
      </header>

      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">Активных: {activeCount}</Badge>
        <Badge variant="outline">Включено в конфигурации: {configuredCount}</Badge>
        <Badge variant="outline">Всего: {state.plugins.length}</Badge>
      </div>

      <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Включение и отключение выполняются через lifecycle runtime: текущий runtime останавливается,
        создаётся новый с обновлённым списком отключённых плагинов и запускается снова. Страница не
        перезагружается; обновляется только состояние.
      </p>

      <SafeModePanel state={state} />

      {error !== null ? (
        <Alert variant="destructive" role="alert" data-testid="plugin-action-error">
          <AlertTitle>Действие не выполнено</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {state.plugins.length === 0 ? (
        <Empty data-testid="plugins-empty">
          <EmptyHeader>
            <EmptyTitle>Плагины не обнаружены</EmptyTitle>
            <EmptyDescription>
              Поместите локальный плагин с `plugin.json` в каталог плагинов и нажмите «Обновить».
              Доменные плагины в этот shell не входят.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" variant="outline" onClick={refresh} disabled={isPending}>
              <RefreshCw data-icon="inline-start" />
              Проверить снова
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {state.plugins.map((plugin) => (
            <PluginCard
              key={plugin.id ?? plugin.source}
              plugin={plugin}
              pending={pendingId === plugin.id}
              disabled={isPending}
              onToggle={toggle}
            />
          ))}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Проверено: <time dateTime={state.checkedAt}>{formatUtc(state.checkedAt)}</time>
        </span>
        <span aria-hidden="true">·</span>
        <span>{state.started ? "Runtime запущен" : "Runtime остановлен"}</span>
        <span aria-hidden="true">·</span>
        <span>Отключено в конфигурации: {state.disabledPluginIds.length}</span>
      </footer>
    </div>
  );
}
