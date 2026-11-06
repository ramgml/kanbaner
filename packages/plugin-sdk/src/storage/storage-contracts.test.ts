import { describe, expect, it } from "vitest";

import * as sdkRoot from "../index.ts";
import {
  BACKEND_ID_PATTERN,
  CORE_STORAGE_STORES,
  STORAGE_ERROR_CODES,
  StorageError,
  createStorageCapabilities,
  currentUtcTimestamp,
  defineStorageStore,
  hasStorageCapability,
  isApplicationId,
  isBackendId,
  isCollectionName,
  isJsonValueInput,
  isMvpStorageProvider,
  isSameStoreContract,
  isStorageErrorShape,
  missingRequiredStorageCapabilities,
  toUtcTimestamp,
} from "./index.ts";

describe("публичные контракты Storage", () => {
  it("экспортируется из корневого SDK", () => {
    expect(sdkRoot.StorageError).toBe(StorageError);
    expect(sdkRoot.createStorageCapabilities).toBe(createStorageCapabilities);
    expect(sdkRoot.CORE_STORAGE_STORES.documents.id).toBe("kanbaner.core.documents.v1");
    expect(sdkRoot.defineStorageStore).toBe(defineStorageStore);
  });

  it("включает только обязательную capability по умолчанию", () => {
    const capabilities = createStorageCapabilities();

    expect(capabilities.transactions).toBe(true);
    expect(capabilities.savepoints).toBe(false);
    expect(hasStorageCapability(capabilities, "transactions")).toBe(true);
    expect(hasStorageCapability(capabilities, "fullTextSearch")).toBe(false);
    expect(missingRequiredStorageCapabilities(capabilities)).toEqual([]);
    expect(isMvpStorageProvider(capabilities)).toBe(true);

    const unsupported = createStorageCapabilities({ transactions: false });

    expect(missingRequiredStorageCapabilities(unsupported)).toEqual(["transactions"]);
    expect(isMvpStorageProvider(unsupported)).toBe(false);
  });

  it("проверяет backendId, application ID и collection", () => {
    expect(isBackendId("in-memory")).toBe(true);
    expect(isBackendId("kanbaner.sqlite")).toBe(true);
    expect(isBackendId("Bad Backend")).toBe(false);
    expect(BACKEND_ID_PATTERN).toContain("[a-z]");

    expect(isApplicationId("01JDOC00000000000000000001")).toBe(true);
    expect(isApplicationId("")).toBe(false);
    expect(isApplicationId("with space")).toBe(false);

    expect(isCollectionName("widgets")).toBe(true);
    expect(isCollectionName("Widgets")).toBe(false);
  });

  it("преобразует время в UTC без сдвига", () => {
    const timestamp = toUtcTimestamp(new Date("2026-11-06T12:00:00.000Z"));

    expect(timestamp).toBe("2026-11-06T12:00:00.000Z");
    expect(currentUtcTimestamp(() => new Date("2026-11-06T12:00:00.000Z"))).toBe(timestamp);

    expect(() => toUtcTimestamp(new Date(Number.NaN))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(() => currentUtcTimestamp(() => new Date(Number.NaN))).toThrowError(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
  });

  it("создаёт структурированную ошибку Storage", () => {
    const error = new StorageError("VERSION_CONFLICT", "Версия устарела", {
      details: { expectedVersion: 1 },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StorageError");
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ expectedVersion: 1 });
    expect(isStorageErrorShape(error)).toBe(true);
    expect(isStorageErrorShape({ code: "UNKNOWN" })).toBe(false);
    expect(new StorageError("HEALTH_CHECK_FAILED", "Нет здоровья").retryable).toBe(true);
    expect(STORAGE_ERROR_CODES).toContain("MIGRATION_CHECKSUM_MISMATCH");
  });

  it("создаёт и сравнивает Store-контракты", () => {
    const contract = defineStorageStore<{ ping(): Promise<string> }>("acme.widgets.store.v1", 1);

    expect(contract).toEqual({ id: "acme.widgets.store.v1", version: 1 });
    expect(isSameStoreContract(contract, { id: "acme.widgets.store.v1", version: 1 })).toBe(true);
    expect(isSameStoreContract(contract, { id: "acme.widgets.store.v1", version: 2 })).toBe(false);

    expect(() => defineStorageStore("not-a-contract", 1)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(() => defineStorageStore("acme.widgets.store.v1", 0)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  it("объявляет встроенные Store-контракты ядра", () => {
    expect(CORE_STORAGE_STORES.documents.id).toBe("kanbaner.core.documents.v1");
    expect(CORE_STORAGE_STORES.links.id).toBe("kanbaner.core.resource-links.v1");
    expect(CORE_STORAGE_STORES.pluginStates.id).toBe("kanbaner.core.plugin-states.v1");
    expect(CORE_STORAGE_STORES.migrations.id).toBe("kanbaner.core.migrations.v1");
    expect(CORE_STORAGE_STORES.searchIndex.id).toBe("kanbaner.core.search-index.v1");
  });

  it("проверяет JSON-значение на границе Store", () => {
    expect(isJsonValueInput({ nested: [1, "two", null, true] })).toBe(true);
    expect(isJsonValueInput(undefined)).toBe(false);
    expect(isJsonValueInput(Number.NaN)).toBe(false);
    expect(isJsonValueInput(new Date())).toBe(false);
  });
});
