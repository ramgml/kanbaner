import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverPluginManifests } from "./discovery.ts";
import { parsePluginManifest } from "./manifest.ts";
import { fixturePath } from "./test-support.ts";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "kanbaner-kan003-discovery-"));

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("discoverPluginManifests", () => {
  it("обнаруживает манифесты в детерминированном порядке", async () => {
    const result = await discoverPluginManifests([fixturePath("order")]);

    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.manifests.map((manifest) => manifest.source)).toEqual([
      "root#0/10-alpha/plugin.json",
      "root#0/20-mid/plugin.json",
      "root#0/50-zeta/plugin.json",
    ]);
    expect(result.manifests.map((manifest) => manifest.rootIndex)).toEqual([0, 0, 0]);
    expect(result.manifests.every((manifest) => manifest.text.length > 0)).toBe(true);
  });

  it("пропускает каталоги без plugin.json", async () => {
    const result = await discoverPluginManifests([fixturePath("empty")]);

    expect(result.manifests).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("сообщает о недоступном корневом каталоге без исключения", async () => {
    const result = await discoverPluginManifests([fixturePath("does-not-exist")]);

    expect(result.manifests).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("plugin_root_unavailable");
    expect(result.diagnostics[0]?.source).toBe("root#0");
    expect(result.diagnostics[0]?.details).toEqual({ rootIndex: 0 });
  });

  it("обнаруживает плагины из нескольких корней с различимым origin", async () => {
    const result = await discoverPluginManifests([
      fixturePath("duplicate/root-a"),
      fixturePath("duplicate/root-b"),
    ]);

    expect(result.manifests.map((manifest) => manifest.source)).toEqual([
      "root#0/dependent/plugin.json",
      "root#0/dup/plugin.json",
      "root#0/healthy/plugin.json",
      "root#1/dup/plugin.json",
    ]);
    expect(result.manifests.map((manifest) => manifest.origin)).toEqual([
      "root#0",
      "root#0",
      "root#0",
      "root#1",
    ]);
    expect(new Set(result.manifests.map((manifest) => manifest.rootIndex))).toEqual(
      new Set([0, 1]),
    );
  });

  it("материализует failure, если plugin.json является каталогом", async () => {
    const result = await discoverPluginManifests([fixturePath("discovery-read-failure")]);

    expect(result.manifests).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.source).toBe("root#0/broken/plugin.json");
    expect(result.failures[0]?.diagnostic.code).toBe("manifest_read_failed");
    expect(result.failures[0]?.diagnostic.pluginId).toBeNull();
    expect(result.failures[0]?.diagnostic.details).toEqual({
      rootIndex: 0,
      reason: "not_file",
    });
    expect(result.diagnostics).toEqual([result.failures[0]?.diagnostic]);
  });

  it("сохраняет BOM при чтении Buffer и декодировании UTF-8", async () => {
    await withTempRoot(async (root) => {
      const directory = join(root, "bom");
      await mkdir(directory);
      const json = JSON.stringify({
        id: "fixture.bom",
        name: "BOM",
        version: "1.0.0",
        hostApi: "^1.0.0",
        entrypoints: { server: "./server.mjs" },
        requires: {},
        consumes: [],
        provides: [],
        permissions: [],
      });
      await writeFile(
        join(directory, "plugin.json"),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
      );

      const result = await discoverPluginManifests([root]);

      expect(result.failures).toEqual([]);
      expect(result.manifests).toHaveLength(1);
      expect(result.manifests[0]?.text.charCodeAt(0)).toBe(0xfeff);
      expect(parsePluginManifest(result.manifests[0]?.text ?? "", "bom").manifest?.id).toBe(
        "fixture.bom",
      );
    });
  });

  it("отклоняет повреждённый UTF-8 без импорта кода", async () => {
    await withTempRoot(async (root) => {
      const directory = join(root, "broken");
      await mkdir(directory);
      await writeFile(join(directory, "plugin.json"), Buffer.from([0x7b, 0xff, 0x7d]));
      await writeFile(
        join(directory, "server.mjs"),
        'throw new Error("INVALID_UTF8_IMPORT_MARKER");\n',
      );

      const result = await discoverPluginManifests([root]);

      expect(result.manifests).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.source).toBe("root#0/broken/plugin.json");
      expect(result.failures[0]?.diagnostic.code).toBe("manifest_read_failed");
      expect(result.failures[0]?.diagnostic.details).toEqual({
        rootIndex: 0,
        reason: "invalid_utf8",
      });
      expect(JSON.stringify(result.diagnostics)).not.toContain(root);
      expect(result.failures[0]?.source).toBe("root#0/broken/plugin.json");
    });
  });
});

describe("parsePluginManifest", () => {
  it("валидирует манифест через SDK", () => {
    const parsed = parsePluginManifest(
      JSON.stringify({
        id: "fixture.valid",
        name: "Valid",
        version: "1.0.0",
        hostApi: "^1.0.0",
        entrypoints: { server: "./server.mjs" },
        requires: {},
        consumes: [],
        provides: [],
        permissions: [],
      }),
      "valid/plugin.json",
    );

    expect(parsed.diagnostic).toBeNull();
    expect(parsed.pluginId).toBe("fixture.valid");
    expect(parsed.manifest?.id).toBe("fixture.valid");
  });

  it("принимает UTF-8 BOM в манифесте", () => {
    const parsed = parsePluginManifest(
      `\uFEFF${JSON.stringify({
        id: "fixture.bom",
        name: "BOM",
        version: "1.0.0",
        hostApi: "^1.0.0",
        entrypoints: { server: "./server.mjs" },
        requires: {},
        consumes: [],
        provides: [],
        permissions: [],
      })}`,
      "bom/plugin.json",
    );

    expect(parsed.diagnostic).toBeNull();
    expect(parsed.manifest?.id).toBe("fixture.bom");
  });

  it("возвращает безопасную диагностику для невалидного JSON", () => {
    const parsed = parsePluginManifest("{ bad", "broken/plugin.json");

    expect(parsed.manifest).toBeNull();
    expect(parsed.pluginId).toBeNull();
    expect(parsed.diagnostic?.code).toBe("manifest_invalid_json");
    expect(parsed.diagnostic?.source).toBe("broken/plugin.json");
  });

  it("сохраняет ID и пути ошибок для невалидной схемы", () => {
    const parsed = parsePluginManifest(
      JSON.stringify({
        id: "fixture.invalid-schema",
        version: "1.0.0",
        hostApi: "^1.0.0",
        entrypoints: { server: "./server.mjs" },
        requires: {},
        consumes: [],
        provides: [],
        permissions: [],
      }),
      "invalid-schema/plugin.json",
    );

    expect(parsed.manifest).toBeNull();
    expect(parsed.pluginId).toBe("fixture.invalid-schema");
    expect(parsed.diagnostic?.code).toBe("manifest_invalid");
    expect(parsed.diagnostic?.details).toBeDefined();
  });
});
