"use client";

import { useEffect } from "react";

import { notesUiPlugin } from "@kanbaner/plugin-notes/ui";
import { opencodeUiPlugin } from "@kanbaner/opencode/ui";
import { projectsUiPlugin } from "@kanbaner/plugin-projects/ui";

import { useUiRegistry } from "./provider";
import type { UiComponent } from "./registry";

/**
 * Единственный composition-модуль, который импортирует UI-entrypoint
 * встроенных плагинов.
 *
 * Shell, слоты и маршрутизация не знают о доменных плагинах: они получают
 * только metadata с сервера и рендереры из клиентского реестра. При
 * отключённом плагине metadata отсутствует, поэтому наличие кода в бандле не
 * делает вклад видимым.
 */
export const builtinUiPlugins = [projectsUiPlugin, notesUiPlugin, opencodeUiPlugin] as const;

export function BuiltinUiPlugins() {
  const registry = useUiRegistry();

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    for (const plugin of builtinUiPlugins) {
      for (const contribution of plugin.contributions) {
        try {
          cleanups.push(
            registry.bindRenderer(
              plugin.id,
              contribution.metadata.id,
              contribution.render as UiComponent,
            ),
          );
        } catch {
          // Битый рендерер не должен ронять composition остальных плагинов.
        }
      }
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [registry]);

  return null;
}
