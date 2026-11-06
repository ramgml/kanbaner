import { readdir, readFile, stat } from "node:fs/promises";
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
  /** Безопасный ярлык `root#N/<каталог>/plugin.json` без абсолютного пути. */
  readonly source: string;
  /** Безопасный ярлык корня `root#N`. */
  readonly origin: string;
  /** Индекс корневого каталога плагинов. */
  readonly rootIndex: number;
  /** Исходный текст манифеста. */
  readonly text: string;
}

/** Манифест, который обнаружен, но не может быть прочитан. */
export interface DiscoveredPluginFailure {
  readonly directory: string;
  readonly source: string;
  readonly origin: string;
  readonly rootIndex: number;
  readonly diagnostic: PluginDiagnostic;
}

export interface PluginDiscoveryResult {
  readonly manifests: readonly DiscoveredPluginManifest[];
  readonly failures: readonly DiscoveredPluginFailure[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

const IGNORED_DIRECTORIES = new Set(["node_modules"]);

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function decodeUtf8(buffer: Uint8Array): string | null {
  try {
    // ignoreBOM сохраняет BOM в тексте; parsePluginManifest снимает его сам.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
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
  const failures: DiscoveredPluginFailure[] = [];
  const diagnostics: PluginDiagnostic[] = [];

  for (const [rootIndex, root] of roots.entries()) {
    const rootPath = resolve(root);
    const origin = `root#${rootIndex}`;
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
          source: origin,
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
      const source = `${origin}/${directoryName}/${PLUGIN_MANIFEST_FILENAME}`;
      let fileInfo;

      try {
        fileInfo = await stat(manifestPath);
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }

        const diagnostic = createDiagnostic({
          code: "manifest_read_failed",
          severity: "error",
          phase: "discovery",
          pluginId: null,
          source,
          message: "Манифест плагина не удалось прочитать",
          details: { rootIndex, reason: "read_failed" },
        });

        failures.push({ directory, source, origin, rootIndex, diagnostic });
        diagnostics.push(diagnostic);
        continue;
      }

      if (!fileInfo.isFile()) {
        const diagnostic = createDiagnostic({
          code: "manifest_read_failed",
          severity: "error",
          phase: "discovery",
          pluginId: null,
          source,
          message: "Манифест плагина не является файлом",
          details: { rootIndex, reason: "not_file" },
        });

        failures.push({ directory, source, origin, rootIndex, diagnostic });
        diagnostics.push(diagnostic);
        continue;
      }

      let buffer: Buffer;

      try {
        buffer = await readFile(manifestPath);
      } catch {
        const diagnostic = createDiagnostic({
          code: "manifest_read_failed",
          severity: "error",
          phase: "discovery",
          pluginId: null,
          source,
          message: "Манифест плагина не удалось прочитать",
          details: { rootIndex, reason: "read_failed" },
        });

        failures.push({ directory, source, origin, rootIndex, diagnostic });
        diagnostics.push(diagnostic);
        continue;
      }

      const text = decodeUtf8(buffer);

      if (text === null) {
        const diagnostic = createDiagnostic({
          code: "manifest_read_failed",
          severity: "error",
          phase: "discovery",
          pluginId: null,
          source,
          message: "Манифест плагина содержит некорректный UTF-8",
          details: { rootIndex, reason: "invalid_utf8" },
        });

        failures.push({ directory, source, origin, rootIndex, diagnostic });
        diagnostics.push(diagnostic);
        continue;
      }

      manifests.push({
        directory,
        manifestPath,
        source,
        origin,
        rootIndex,
        text,
      });
    }
  }

  const compareByOrigin = (
    left: { source: string; rootIndex: number; directory: string },
    right: { source: string; rootIndex: number; directory: string },
  ): number => {
    return (
      compareStrings(left.source, right.source) ||
      left.rootIndex - right.rootIndex ||
      compareStrings(left.directory, right.directory)
    );
  };

  manifests.sort(compareByOrigin);
  failures.sort(compareByOrigin);

  return { manifests, failures, diagnostics };
}
