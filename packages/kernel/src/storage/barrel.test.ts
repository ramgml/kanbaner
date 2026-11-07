import { StorageError as SdkStorageError } from "@kanbaner/plugin-sdk";
import { describe, expect, it } from "vitest";

import * as kernel from "../index.ts";

describe("barrel Storage-слоя ядра", () => {
  it("экспортирует провайдеры, реестр, миграции и conformance suite", () => {
    expect(kernel.InMemoryStorageProvider).toBeTypeOf("function");
    expect(kernel.StorageProviderRegistry).toBeTypeOf("function");
    expect(kernel.StorageMigrationRunner).toBeTypeOf("function");
    expect(kernel.bootstrapStorage).toBeTypeOf("function");
    expect(kernel.createPluginMigrationHook).toBeTypeOf("function");
    expect(kernel.createStorageProviderConformanceSuite).toBeTypeOf("function");
  });

  it("использует публичный StorageError SDK", () => {
    expect(kernel.StorageError).toBe(SdkStorageError);
    expect(kernel.storageError("VERSION_CONFLICT", "conflict")).toBeInstanceOf(SdkStorageError);
  });
});
