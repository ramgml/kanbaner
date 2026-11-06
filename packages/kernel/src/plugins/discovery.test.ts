import { describe, expect, it } from "vitest";

import { discoverPluginManifests } from "./discovery.ts";
import { parsePluginManifest } from "./manifest.ts";
import { fixturePath } from "./test-support.ts";

describe("discoverPluginManifests", () => {
  it("обнаруживает манифесты в детерминированном порядке", async () => {
    const result = await discoverPluginManifests([fixturePath("order")]);

    expect(result.diagnostics).toEqual([]);
    expect(result.manifests.map((manifest) => manifest.source)).toEqual([
      "10-alpha/plugin.json",
      "20-mid/plugin.json",
      "50-zeta/plugin.json",
    ]);
    expect(result.manifests.map((manifest) => manifest.rootIndex)).toEqual([0, 0, 0]);
    expect(result.manifests.every((manifest) => manifest.text.length > 0)).toBe(true);
  });

  it("пропускает каталоги без plugin.json", async () => {
    const result = await discoverPluginManifests([fixturePath("empty")]);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("сообщает о недоступном корневом каталоге без исключения", async () => {
    const result = await discoverPluginManifests([fixturePath("does-not-exist")]);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("plugin_root_unavailable");
    expect(result.diagnostics[0]?.details).toEqual({ rootIndex: 0 });
  });

  it("обнаруживает плагины из нескольких корней", async () => {
    const result = await discoverPluginManifests([
      fixturePath("duplicate/root-a"),
      fixturePath("duplicate/root-b"),
    ]);

    expect(result.manifests.map((manifest) => manifest.source)).toEqual([
      "dependent/plugin.json",
      "dup/plugin.json",
      "dup/plugin.json",
      "healthy/plugin.json",
    ]);
    expect(new Set(result.manifests.map((manifest) => manifest.rootIndex))).toEqual(
      new Set([0, 1]),
    );
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
