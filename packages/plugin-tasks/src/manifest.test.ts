import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validatePluginManifest, type PluginManifest } from "@kanbaner/plugin-sdk";

function packageRoot(): string {
  const fromRepositoryRoot = path.resolve(process.cwd(), "packages", "plugin-tasks");

  return existsSync(path.join(fromRepositoryRoot, "plugin.json"))
    ? fromRepositoryRoot
    : process.cwd();
}

function readManifest(): PluginManifest {
  const file = path.join(packageRoot(), "plugin.json");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const result = validatePluginManifest(parsed);

  if (!result.ok) {
    throw new Error(
      `plugin.json невалиден: ${result.errors.map((issue) => issue.message).join("; ")}`,
    );
  }

  return result.value;
}

describe("plugin.json", () => {
  it("описывает канонический Plugin ID и контракты задач", () => {
    const manifest = readManifest();

    expect(manifest.id).toBe("kanbaner.tasks");
    expect(manifest.hostApi).toBe("^1.0.0");
    expect(manifest.provides).toEqual([
      "kanbaner.tasks.commands.v1",
      "kanbaner.tasks.queries.v1",
      "kanbaner.tasks.events.v1",
    ]);
    expect(manifest.consumes).toEqual([]);
  });

  it("заявляет только разрешённые permissions и не содержит SQL-миграций", () => {
    const manifest = readManifest();

    expect([...manifest.permissions].sort()).toEqual(["commands", "events", "search", "storage"]);
    expect(manifest.migrations).toBeUndefined();
  });
});
