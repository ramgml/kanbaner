import { compareStrings } from "./diagnostics.ts";

export interface DependencyNode {
  readonly id: string;
  readonly version: string;
  readonly requires: Readonly<Record<string, string>>;
}

export interface PluginGraph {
  /** Сильно связные компоненты, содержащие цикл. Участники отсортированы. */
  readonly cycles: readonly (readonly string[])[];
  /**
   * Топологический порядок ациклических узлов: зависимости раньше зависимых.
   *
   * Узлы циклов исключены; их зависимые остаются в порядке и будут
   * заблокированы на этапе разрешения зависимостей.
   */
  readonly order: readonly string[];
  readonly nodesById: ReadonlyMap<string, DependencyNode>;
  readonly dependenciesById: ReadonlyMap<string, readonly string[]>;
  readonly dependentsById: ReadonlyMap<string, readonly string[]>;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function buildAdjacency(
  ids: readonly string[],
  dependenciesById: ReadonlyMap<string, readonly string[]>,
  reverse: boolean,
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, string[]>();

  for (const id of ids) {
    adjacency.set(id, []);
  }

  for (const id of ids) {
    const dependencies = dependenciesById.get(id) ?? [];

    for (const dependency of dependencies) {
      if (!adjacency.has(dependency)) {
        continue;
      }

      if (reverse) {
        adjacency.get(dependency)?.push(id);
      } else {
        adjacency.get(id)?.push(dependency);
      }
    }
  }

  for (const [id, neighbors] of adjacency) {
    adjacency.set(id, neighbors.sort(compareStrings));
  }

  return adjacency;
}

interface DfsFrame {
  readonly id: string;
  index: number;
}

/** Итеративный первый проход Косараджу: порядок завершения DFS. */
function finishingOrder(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[] {
  const visited = new Set<string>();
  const order: string[] = [];

  for (const start of ids) {
    if (visited.has(start)) {
      continue;
    }

    const stack: DfsFrame[] = [{ id: start, index: 0 }];
    visited.add(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];

      if (frame === undefined) {
        break;
      }

      const neighbors = adjacency.get(frame.id) ?? [];

      if (frame.index < neighbors.length) {
        const next = neighbors[frame.index];
        frame.index += 1;

        if (next !== undefined && !visited.has(next)) {
          visited.add(next);
          stack.push({ id: next, index: 0 });
        }

        continue;
      }

      order.push(frame.id);
      stack.pop();
    }
  }

  return order;
}

function stronglyConnectedComponents(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  reversed: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const order = finishingOrder(ids, adjacency);
  const assigned = new Set<string>();
  const components: string[][] = [];

  for (let index = order.length - 1; index >= 0; index -= 1) {
    const start = order[index];

    if (start === undefined || assigned.has(start)) {
      continue;
    }

    const component: string[] = [];
    const stack = [start];
    assigned.add(start);

    while (stack.length > 0) {
      const current = stack.pop();

      if (current === undefined) {
        break;
      }

      component.push(current);

      for (const neighbor of reversed.get(current) ?? []) {
        if (!assigned.has(neighbor)) {
          assigned.add(neighbor);
          stack.push(neighbor);
        }
      }
    }

    components.push(component.sort(compareStrings));
  }

  return components;
}

/**
 * Строит детерминированный граф зависимостей и топологический порядок.
 *
 * Алгоритм не зависит от порядка файлов: все списки сортируются по Plugin ID,
 * а готовые к активации узлы выбираются лексикографически.
 */
export function buildPluginGraph(nodes: readonly DependencyNode[]): PluginGraph {
  const sortedNodes = [...nodes].sort((left, right) => compareStrings(left.id, right.id));
  const nodesById = new Map(sortedNodes.map((node) => [node.id, node]));
  const ids = sortedNodes.map((node) => node.id);

  const dependenciesById = new Map<string, readonly string[]>();

  for (const node of sortedNodes) {
    dependenciesById.set(
      node.id,
      uniqueSorted(Object.keys(node.requires).filter((dependency) => nodesById.has(dependency))),
    );
  }

  const adjacency = buildAdjacency(ids, dependenciesById, false);
  const reversed = buildAdjacency(ids, dependenciesById, true);

  const components = stronglyConnectedComponents(ids, adjacency, reversed);
  const cycles: string[][] = [];

  for (const component of components) {
    const first = component[0];
    const isSelfCycle =
      component.length === 1 &&
      first !== undefined &&
      (dependenciesById.get(first) ?? []).includes(first);

    if (component.length > 1 || isSelfCycle) {
      cycles.push(component);
    }
  }

  cycles.sort((left, right) => {
    return compareStrings(left[0] ?? "", right[0] ?? "");
  });

  const cycleNodes = new Set(cycles.flat());
  const remaining = ids.filter((id) => !cycleNodes.has(id));
  const remainingSet = new Set(remaining);
  const indegree = new Map<string, number>();
  const dependentsById = new Map<string, readonly string[]>();

  for (const id of remaining) {
    const dependencies = (dependenciesById.get(id) ?? []).filter((dependency) =>
      remainingSet.has(dependency),
    );
    indegree.set(id, dependencies.length);
    dependentsById.set(
      id,
      (reversed.get(id) ?? []).filter((dependent) => remainingSet.has(dependent)),
    );
  }

  const available = remaining.filter((id) => (indegree.get(id) ?? 0) === 0).sort(compareStrings);
  const order: string[] = [];

  while (available.length > 0) {
    const id = available.shift();

    if (id === undefined) {
      break;
    }

    order.push(id);

    for (const dependent of dependentsById.get(id) ?? []) {
      const nextDegree = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, nextDegree);

      if (nextDegree === 0) {
        available.push(dependent);
        available.sort(compareStrings);
      }
    }
  }

  // Страховка: если из-за ошибки в графе остались узлы, не помечаем их
  // активируемыми. Для корректного графа этот блок недостижим.
  if (order.length !== remaining.length) {
    const emitted = new Set(order);
    const leftovers = remaining.filter((id) => !emitted.has(id));

    if (leftovers.length > 0) {
      cycles.push(leftovers.sort(compareStrings));
    }
  }

  return {
    cycles,
    order,
    nodesById,
    dependenciesById,
    dependentsById,
  };
}
