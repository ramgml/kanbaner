import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PluginDiagnostic } from "../lifecycle/index.ts";
import { compareStrings, createDiagnostic } from "./diagnostics.ts";

/** Имя файла манифеста в каталоге плагина. */
export const PLUGIN_MANIFEST_FILENAME = "plugin.json";

export interface DiscoveredPluginManifest {
  /** Абсолютный каталог плагина. */
  readonly directory: string;
  /** Абсолютный путь к манифесту. */
  readonly manifestPath: string;
  /** Безопасный ярлык вида `<каталог>/plugin.json` без абсолютного пути. */
  readonly source: string;
  /** Индекс корневого каталога плагинов. */
  readonly rootIndex: number;
  /** Исходный текст манифеста. */
  readonly text: string;
}

export interface PluginDiscoveryResult {
  readonly manifests: readonly DiscoveredPluginManifest[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

const IGNORED_DIRECTORIES = new Set(["node_modules"]);

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Обнаруживает манифесты в локальных каталогах плагинов.
 *
 * Каждый плагин — непосредственный подкаталог корня, содержащий `plugin.json`.
 * Порядок не зависит от порядка файловой системы: результаты сортируются по
 * безопасному ярлыку, индексу корня и пути.
 */
export async function discoverPluginManifests(
  roots: readonly string[],
): Promise<PluginDiscoveryResult> {
  const manifests: DiscoveredPluginManifest[] = [];
  const diagnostics: PluginDiagnostic[] = [];

  for (const [rootIndex, root] of roots.entries()) {
    const rootPath = resolve(root);
    let entries;

    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      diagnostics.push(
        createDiagnostic({
          code: "plugin_root_unavailable",
          severity: "error",
          phase: "discovery",
          pluginId: null,
          source: null,
          message: "Каталог плагинов недоступен",
          details: { rootIndex },
        }),
      );
      continue;
    }

    const directoryNames = entries
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort(compareStrings);

    for (const directoryName of directoryNames) {
      const directory = join(rootPath, directoryName);
      const manifestPath = join(directory, PLUGIN_MANIFEST_FILENAME);
      const source = `${directoryName}/${PLUGIN_MANIFEST_FILENAME}`;
      let text: string;

      try {
        text = await readFile(manifestPath, "utf8");
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }

        diagnostics.push(
          createDiagnostic({
            code: "manifest_read_failed",
            severity: "error",
            phase: "discovery",
            pluginId: null,
            source,
            message: "Манифест плагина не удалось прочитать",
            details: { rootIndex },
          }),
        );
        continue;
      }

      manifests.push({
        directory,
        manifestPath,
        source,
        rootIndex,
        text,
      });
    }
  }

  manifests.sort((left, right) => {
    return (
      compareStrings(left.source, right.source) ||
      left.rootIndex - right.rootIndex ||
      compareStrings(left.directory, right.directory)
    );
  });

  return { manifests, diagnostics };
}
