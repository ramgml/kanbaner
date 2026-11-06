import { describe, expect, it } from "vitest";

import { KERNEL_API_VERSION, describeKernel } from "./index.ts";

describe("@kanbaner/kernel", () => {
  it("возвращает версии ядра и Plugin Contract", () => {
    const kernel = describeKernel();

    expect(kernel).toEqual({
      apiVersion: KERNEL_API_VERSION,
      pluginContractVersion: "1",
    });
  });
});
