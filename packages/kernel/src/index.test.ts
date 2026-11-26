import { describe, expect, it } from "vitest";

import {
  EventBus,
  KERNEL_API_VERSION,
  KernelResourceService,
  createOperationBus,
  createPluginRuntime,
  describeKernel,
} from "./index.ts";

describe("@kanbaner/kernel", () => {
  it("возвращает версии ядра и Plugin Contract", () => {
    const kernel = describeKernel();

    expect(kernel).toEqual({
      apiVersion: KERNEL_API_VERSION,
      pluginContractVersion: "1",
    });
  });

  it("экспортирует публичные runtime, operations, events и resources", () => {
    expect(createPluginRuntime).toBeTypeOf("function");
    expect(createOperationBus).toBeTypeOf("function");
    expect(EventBus).toBeTypeOf("function");
    expect(KernelResourceService).toBeTypeOf("function");
  });
});
