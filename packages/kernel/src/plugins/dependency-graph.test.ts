import { describe, expect, it } from "vitest";

import { buildPluginGraph, type DependencyNode } from "./dependency-graph.ts";

function node(
  id: string,
  requires: Record<string, string> = {},
  version = "1.0.0",
): DependencyNode {
  return { id, version, requires };
}

describe("buildPluginGraph", () => {
  it("ставит зависимости раньше зависимых и разрешает независимые узлы по ID", () => {
    const graph = buildPluginGraph([
      node("fixture.omega", {
        "fixture.alpha": "^1.0.0",
        "fixture.mid": "^1.0.0",
      }),
      node("fixture.mid", { "fixture.zeta": "^1.0.0" }),
      node("fixture.alpha", { "fixture.zeta": "^1.0.0" }),
      node("fixture.zeta"),
    ]);

    expect(graph.order).toEqual(["fixture.zeta", "fixture.alpha", "fixture.mid", "fixture.omega"]);
    expect(graph.cycles).toEqual([]);
  });

  it("не зависит от порядка входного массива", () => {
    const nodes = [
      node("fixture.zeta"),
      node("fixture.alpha", { "fixture.zeta": "^1.0.0" }),
      node("fixture.mid", { "fixture.zeta": "^1.0.0" }),
    ];

    const first = buildPluginGraph(nodes);
    const second = buildPluginGraph([...nodes].reverse());
    const third = buildPluginGraph([
      nodes[1] as DependencyNode,
      nodes[2] as DependencyNode,
      nodes[0] as DependencyNode,
    ]);

    expect(first.order).toEqual(second.order);
    expect(first.order).toEqual(third.order);
    expect(first.order).toEqual(["fixture.zeta", "fixture.alpha", "fixture.mid"]);
  });

  it("сортирует независимые узлы лексикографически по Plugin ID", () => {
    const graph = buildPluginGraph([
      node("fixture.zulu"),
      node("fixture.alpha"),
      node("fixture.mike"),
    ]);

    expect(graph.order).toEqual(["fixture.alpha", "fixture.mike", "fixture.zulu"]);
  });

  it("возвращает участников цикла и исключает их из порядка", () => {
    const graph = buildPluginGraph([
      node("fixture.cycle-alpha", { "fixture.cycle-beta": "^1.0.0" }),
      node("fixture.cycle-beta", { "fixture.cycle-alpha": "^1.0.0" }),
      node("fixture.dependent", { "fixture.cycle-alpha": "^1.0.0" }),
      node("fixture.healthy"),
    ]);

    expect(graph.cycles).toEqual([["fixture.cycle-alpha", "fixture.cycle-beta"]]);
    expect(graph.order).toEqual(["fixture.dependent", "fixture.healthy"]);
  });

  it("обнаруживает самозависимость как цикл", () => {
    const graph = buildPluginGraph([
      node("fixture.self", { "fixture.self": "^1.0.0" }),
      node("fixture.healthy"),
    ]);

    expect(graph.cycles).toEqual([["fixture.self"]]);
    expect(graph.order).toEqual(["fixture.healthy"]);
  });

  it("не считает отсутствующую зависимость ребром графа", () => {
    const graph = buildPluginGraph([
      node("fixture.dependent", { "fixture.absent": "^1.0.0" }),
      node("fixture.healthy"),
    ]);

    expect(graph.cycles).toEqual([]);
    expect(graph.order).toEqual(["fixture.dependent", "fixture.healthy"]);
    expect(graph.dependenciesById.get("fixture.dependent")).toEqual([]);
  });

  it("различает несколько независимых циклов", () => {
    const graph = buildPluginGraph([
      node("fixture.one", { "fixture.two": "^1.0.0" }),
      node("fixture.two", { "fixture.one": "^1.0.0" }),
      node("fixture.three", { "fixture.four": "^1.0.0" }),
      node("fixture.four", { "fixture.three": "^1.0.0" }),
      node("fixture.healthy"),
    ]);

    expect(graph.cycles).toEqual([
      ["fixture.four", "fixture.three"],
      ["fixture.one", "fixture.two"],
    ]);
    expect(graph.order).toEqual(["fixture.healthy"]);
  });
});
