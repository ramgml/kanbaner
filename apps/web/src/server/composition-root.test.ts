import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KERNEL_API_VERSION } from "@kanbaner/kernel";
import { afterEach, describe, expect, it } from "vitest";

import { createApplicationComposition } from "./composition-root";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kanbaner-composition-"));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("application composition root", () => {
  it("создаёт общие сервисы поверх активного Storage Provider", async () => {
    const composition = await createApplicationComposition({
      storage: { dataDirectory: temporaryDirectory() },
    });

    try {
      expect(composition.kernel.apiVersion).toBe(KERNEL_API_VERSION);
      expect(composition.kernel.pluginContractVersion).toBe("1");
      expect(composition.storageProvider.backendId).toBe("sqlite");
      expect(composition.storage.health.ok).toBe(true);
      expect(composition.pluginComposition.events).toBeDefined();
      expect(composition.pluginComposition.operations).toBeDefined();
      expect(composition.pluginComposition.resources).toBeDefined();
      expect(composition.pluginComposition.links).toBeDefined();
      expect(composition.pluginComposition.services.storage).toBe(composition.storageProvider);
      expect(composition.plugins).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("использует LinkStore активного provider, а не in-memory реализацию", async () => {
    const composition = await createApplicationComposition({
      storage: { dataDirectory: temporaryDirectory() },
    });

    try {
      const source = "kanbaner.fixture:item:one";
      const target = "kanbaner.fixture:item:two";

      await composition.pluginComposition.links.link(source, target, "kanbaner.fixture.references");

      const stored = await composition.storageProvider.links.listByRef(source);

      expect(stored).toHaveLength(1);
      expect(stored[0]?.targetRef).toBe(target);
    } finally {
      await composition.close();
    }
  });
});
