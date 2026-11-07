"use client";

import { useId } from "react";

import { AlertTriangle, CheckCircle2, CircleSlash, ShieldAlert } from "lucide-react";

import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import type { PluginManagerDiagnostic, PluginManagerEntry } from "../../lib/plugin-manager-types";

function statusLabel(plugin: PluginManagerEntry): string {
  switch (plugin.status) {
    case "active":
      return "Активен";
    case "disabled":
      return "Отключён";
    case "failed":
      return "Ошибка";
    case "incompatible":
      return "Несовместим";
    case "missing_dependency":
      return "Нет зависимости";
    case "safe_mode":
      return "Safe mode";
    default:
      return "Не активирован";
  }
}

function statusVariant(
  plugin: PluginManagerEntry,
): "default" | "secondary" | "destructive" | "outline" {
  switch (plugin.status) {
    case "active":
      return "secondary";
    case "failed":
    case "incompatible":
    case "missing_dependency":
      return "destructive";
    case "disabled":
      return "outline";
    default:
      return "outline";
  }
}

function StatusIcon({ plugin }: { readonly plugin: PluginManagerEntry }) {
  if (plugin.activated) {
    return <CheckCircle2 aria-hidden="true" className="size-4" />;
  }

  if (plugin.status === "disabled") {
    return <CircleSlash aria-hidden="true" className="size-4" />;
  }

  if (plugin.status === "safe_mode") {
    return <ShieldAlert aria-hidden="true" className="size-4" />;
  }

  return <AlertTriangle aria-hidden="true" className="size-4" />;
}

function DiagnosticList({
  diagnostics,
}: {
  readonly diagnostics: readonly PluginManagerDiagnostic[];
}) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").slice(-3);

  if (errors.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Последние ошибки
      </h3>
      <ul className="flex flex-col gap-2">
        {errors.map((diagnostic, index) => (
          <li
            key={`${diagnostic.code}-${String(index)}`}
            className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs"
          >
            <p className="font-medium text-destructive">{diagnostic.code}</p>
            <p className="mt-1 text-muted-foreground">{diagnostic.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface PluginCardProps {
  readonly plugin: PluginManagerEntry;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onToggle: (pluginId: string, enabled: boolean) => void;
}

export function PluginCard({ plugin, pending, disabled, onToggle }: PluginCardProps) {
  const controlId = useId();
  const stateId = `${controlId}-state`;

  return (
    <Card data-testid="plugin-card" data-plugin-id={plugin.id ?? undefined}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
              <StatusIcon plugin={plugin} />
              <span className="truncate">{plugin.name}</span>
            </CardTitle>
            <CardDescription className="font-mono text-xs break-all">
              {plugin.id ?? "манифест не прочитан"}
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(plugin)}>
              {pending ? <Spinner aria-label="Сохранение" /> : null}
              {statusLabel(plugin)}
            </Badge>
          </div>
        </div>

        <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
          <label htmlFor={controlId} className="flex min-w-0 flex-col gap-0.5 text-sm">
            <span className="font-medium">{plugin.configuredEnabled ? "Включён" : "Отключён"}</span>
            <span id={stateId} className="text-xs text-muted-foreground">
              {plugin.configuredEnabled
                ? plugin.activated
                  ? "Активирован runtime"
                  : "В конфигурации включён, но не активен"
                : "Плагин не будет активирован при следующем запуске"}
            </span>
          </label>
          <Switch
            id={controlId}
            checked={plugin.configuredEnabled}
            disabled={!plugin.canToggle || pending || disabled}
            aria-label={`Включить плагин ${plugin.name}`}
            aria-describedby={stateId}
            onCheckedChange={(checked) => {
              if (plugin.id !== null) {
                onToggle(plugin.id, checked);
              }
            }}
          />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs tracking-wide text-muted-foreground uppercase">Версия</dt>
            <dd className="font-medium">{plugin.version ?? "—"}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs tracking-wide text-muted-foreground uppercase">Host API</dt>
            <dd className="font-medium">{plugin.hostApi ?? "—"}</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs tracking-wide text-muted-foreground uppercase">Источник</dt>
            <dd className="font-mono text-xs break-all text-muted-foreground">{plugin.source}</dd>
          </div>
        </dl>

        {plugin.requires.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Зависимости
              </h3>
              <ul className="flex flex-wrap gap-1.5">
                {plugin.requires.map((requirement) => (
                  <li key={requirement.id}>
                    <Badge variant="outline" className="font-mono">
                      {requirement.id} {requirement.range}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}

        {plugin.permissions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Заявленные возможности
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {plugin.permissions.map((permission) => (
                <li key={permission}>
                  <Badge variant="ghost">{permission}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DiagnosticList diagnostics={plugin.diagnostics} />
      </CardContent>
    </Card>
  );
}
