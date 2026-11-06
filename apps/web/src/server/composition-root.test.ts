import { describe, expect, it } from "vitest";

import { KERNEL_API_VERSION } from "@kanbaner/kernel";

import { createApplicationComposition } from "./composition-root";

describe("application composition root", () => {
  it("запускается без Storage Provider и доменных плагинов", () => {
    const composition = createApplicationComposition();

    expect(composition.kernel.apiVersion).toBe(KERNEL_API_VERSION);
    expect(composition.kernel.pluginContractVersion).toBe("1");
    expect(composition.storageProvider).toBeNull();
    expect(composition.plugins).toEqual([]);
  });
});
