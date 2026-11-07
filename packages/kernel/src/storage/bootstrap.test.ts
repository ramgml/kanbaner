import { describe, expect, it } from "vitest";

import type { StorageMigration } from "./contracts.ts";
import { bootstrapStorage } from "./bootstrap.ts";
import { InMemoryStorageProvider } from "./in-memory-provider.ts";
import { StorageProviderRegistry } from "./registry.ts";

const NOW = () => new Date("2026-11-06T12:00:00.000Z");
const PLUGIN = "acme.widgets";

class RecordingProvider extends InMemoryStorageProvider {
  readonly events: string[] = [];

  override async open(): Promise<void> {
    this.events.push("open");
    await super.open();
  }

  override async close(): Promise<void> {
    this.events.push("close");
    await super.close();
  }

  override async healthCheck() {
    this.events.push("health");
    return super.healthCheck();
  }
}

class FailingOpenProvider extends InMemoryStorageProvider {
  override async open(): Promise<void> {
    throw new Error("open failed");
  }
}

class PartiallyFailingOpenProvider extends RecordingProvider {
  override async open(): Promise<void> {
    await super.open();
    throw new Error("open failed after opening");
  }
}

class FailingCloseProvider extends RecordingProvider {
  override async close(): Promise<void> {
    this.events.push("close-failed");
    throw new Error("close failed");
  }
}

class UnhealthyProvider extends InMemoryStorageProvider {
  override async healthCheck() {
    return {
      ok: false,
      backendId: this.backendId,
      checkedAt: "2026-11-06T12:00:00.000Z",
    } as const;
  }
}

function migration(onUp: () => void): StorageMigration {
  return {
    pluginId: PLUGIN,
    version: 1,
    name: "init",
    source: "bootstrap migration",
    async up() {
      onUp();
    },
  };
}

describe("bootstrapStorage", () => {
  it("открывает и проверяет провайдер до миграций", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new RecordingProvider({ backendId: "memory-bootstrap", now: NOW });
    let migrated = false;

    const result = await bootstrapStorage({
      registry,
      provider,
      now: NOW,
      migrations: [
        migration(() => {
          migrated = true;
          provider.events.push("migrate");
        }),
      ],
    });

    expect(migrated).toBe(true);
    expect(provider.events.indexOf("open")).toBeLessThan(provider.events.indexOf("migrate"));
    expect(provider.events.indexOf("health")).toBeLessThan(provider.events.indexOf("migrate"));
    expect(result.provider).toBe(provider);
    expect(result.health.ok).toBe(true);
    expect(result.migrations.applied).toHaveLength(1);
    expect(provider.events.filter((event) => event === "health")).toHaveLength(1);
    expect(registry.getActive()).toBe(provider);

    await registry.closeAll();
  });

  it("не применяет миграции при ошибке открытия", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new FailingOpenProvider({ backendId: "memory-open-fails", now: NOW });
    let migrated = false;

    await expect(
      bootstrapStorage({
        registry,
        provider,
        migrations: [
          migration(() => {
            migrated = true;
          }),
        ],
      }),
    ).rejects.toThrow("open failed");

    expect(migrated).toBe(false);
    expect(() => registry.getActive()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_BACKEND" }),
    );
  });

  it("не применяет миграции при неуспешном health check", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new UnhealthyProvider({ backendId: "memory-bootstrap-unhealthy", now: NOW });
    let migrated = false;

    await expect(
      bootstrapStorage({
        registry,
        provider,
        migrations: [
          migration(() => {
            migrated = true;
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "HEALTH_CHECK_FAILED" });

    expect(migrated).toBe(false);
  });

  it("не применяет миграции при дублирующем backendId", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new InMemoryStorageProvider({ backendId: "memory-duplicate", now: NOW });
    let migrated = false;

    await bootstrapStorage({ registry, provider });
    await expect(
      bootstrapStorage({
        registry,
        provider,
        migrations: [
          migration(() => {
            migrated = true;
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_BACKEND" });

    expect(migrated).toBe(false);
    await registry.closeAll();
  });

  it("закрывает провайдер при неуспешном health check", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new UnhealthyProvider({
      backendId: "memory-bootstrap-unhealthy-close",
      now: NOW,
    });

    await expect(
      bootstrapStorage({
        registry,
        provider,
      }),
    ).rejects.toMatchObject({ code: "HEALTH_CHECK_FAILED" });

    expect((await provider.healthCheck()).ok).toBe(false);
    expect(() => registry.getActive()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_BACKEND" }),
    );
  });

  it("закрывает частично открытый провайдер при ошибке open", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new PartiallyFailingOpenProvider({
      backendId: "memory-partial-open",
      now: NOW,
    });

    await expect(
      bootstrapStorage({
        registry,
        provider,
      }),
    ).rejects.toThrow("open failed after opening");

    expect(provider.events).toContain("close");
    expect((await provider.healthCheck()).ok).toBe(false);
    expect(() => registry.getActive()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_BACKEND" }),
    );
  });

  it("закрывает провайдер и очищает активный backend при ошибке миграции", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new RecordingProvider({ backendId: "memory-migration-fails", now: NOW });

    await expect(
      bootstrapStorage({
        registry,
        provider,
        migrations: [
          {
            pluginId: PLUGIN,
            version: 1,
            name: "failing",
            source: "failing migration",
            async up() {
              throw new Error("migration failed");
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    expect(provider.events).toContain("close");
    expect((await provider.healthCheck()).ok).toBe(false);
    expect(() => registry.getActive()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_BACKEND" }),
    );
  });

  it("сохраняет первичную ошибку миграции при ошибке cleanup", async () => {
    const registry = new StorageProviderRegistry();
    const provider = new FailingCloseProvider({ backendId: "memory-cleanup-fails", now: NOW });

    await expect(
      bootstrapStorage({
        registry,
        provider,
        migrations: [
          {
            pluginId: PLUGIN,
            version: 1,
            name: "failing",
            source: "failing migration",
            async up() {
              throw new Error("migration failed");
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    expect(provider.events).toContain("close-failed");
    expect(() => registry.getActive()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_BACKEND" }),
    );
  });
});
