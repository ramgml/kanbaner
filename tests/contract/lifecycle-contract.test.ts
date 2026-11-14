// @vitest-environment node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { InMemoryStorageProvider } from "@kanbaner/kernel";
import { afterEach, describe, expect, it } from "vitest";

import { heavyPluginSuite } from "../suite-timeouts.ts";
import {
  removeDirectory,
  startFixtureHarness,
  temporaryDirectory,
  type FixtureHarness,
} from "./fixture-harness.ts";

const harnesses: FixtureHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }

  for (const directory of directories.splice(0)) {
    removeDirectory(directory);
  }
});

interface PluginSpec {
  readonly directory: string;
  readonly id: string;
  readonly requires?: Readonly<Record<string, string>>;
  readonly server: string;
}

function writePlugin(root: string, spec: PluginSpec): void {
  const directory = path.join(root, spec.directory);

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "plugin.json"),
    JSON.stringify(
      {
        id: spec.id,
        name: spec.id,
        version: "1.0.0",
        hostApi: "^1.0.0",
        entrypoints: { server: "./server.mjs" },
        requires: spec.requires ?? {},
        consumes: [],
        provides: [],
        permissions: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(directory, "server.mjs"), spec.server);
}

function registryRoot(): string {
  const root = temporaryDirectory("kanbaner-kan008-plugins-");
  directories.push(root);

  return root;
}

function memoryProvider(): InMemoryStorageProvider {
  return new InMemoryStorageProvider({
    backendId: `memory-contract-${globalThis.crypto.randomUUID()}`,
  });
}

const EMPTY_ACTIVATE = "export function activate() {}\n";

const DUPLICATE_COMMAND = `
const metadata = {
  id: "dup.alpha.op",
  contract: "dup.alpha.commands.v1",
  version: 1,
  kind: "mutation",
  risk: "write",
  idempotency: "none",
  exposure: { ui: false, http: false, mcp: false },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export function activate(context) {
  context.commands.register({ metadata, handler: () => ({ ok: true }) });
  context.commands.register({ metadata, handler: () => ({ ok: true }) });
}
`;

describe("Plugin Contract: lifecycle и изоляция ошибок", heavyPluginSuite, () => {
  it("блокирует дублирующийся command ID и снимает частичную регистрацию", async () => {
    const root = registryRoot();

    writePlugin(root, {
      directory: "alpha",
      id: "dup.alpha",
      server: DUPLICATE_COMMAND,
    });

    const harness = await startFixtureHarness({
      provider: memoryProvider(),
      migrate: false,
      pluginDirectories: [root],
    });

    harnesses.push(harness);

    const plugin = harness.snapshot.plugins.find((entry) => entry.pluginId === "dup.alpha");

    expect(plugin?.status).toBe("failed");
    expect(plugin?.diagnostics.at(-1)?.code).toBe("activation_failed");
    expect(harness.composition.operations.registry.has("dup.alpha.op")).toBe(false);
    expect(harness.snapshot.safeMode).toBe(true);
  });

  it("отсутствующая зависимость блокирует только зависимый плагин", async () => {
    const root = registryRoot();

    writePlugin(root, { directory: "alpha", id: "missing.alpha", server: EMPTY_ACTIVATE });
    writePlugin(root, {
      directory: "beta",
      id: "missing.beta",
      requires: { "acme.ghost": "^1.0.0" },
      server: EMPTY_ACTIVATE,
    });

    const harness = await startFixtureHarness({
      provider: memoryProvider(),
      migrate: false,
      pluginDirectories: [root],
    });

    harnesses.push(harness);

    expect(
      harness.snapshot.plugins.find((entry) => entry.pluginId === "missing.alpha")?.status,
    ).toBe("active");
    expect(
      harness.snapshot.plugins.find((entry) => entry.pluginId === "missing.beta")?.status,
    ).toBe("missing_dependency");
  });

  it("блокирует цикл зависимостей и не мешает здоровому плагину", async () => {
    const root = registryRoot();

    writePlugin(root, {
      directory: "alpha",
      id: "cycle.alpha",
      requires: { "cycle.beta": "^1.0.0" },
      server: EMPTY_ACTIVATE,
    });
    writePlugin(root, {
      directory: "beta",
      id: "cycle.beta",
      requires: { "cycle.alpha": "^1.0.0" },
      server: EMPTY_ACTIVATE,
    });
    writePlugin(root, { directory: "healthy", id: "cycle.healthy", server: EMPTY_ACTIVATE });

    const harness = await startFixtureHarness({
      provider: memoryProvider(),
      migrate: false,
      pluginDirectories: [root],
    });

    harnesses.push(harness);

    expect(harness.snapshot.plugins.find((entry) => entry.pluginId === "cycle.alpha")?.status).toBe(
      "failed",
    );
    expect(harness.snapshot.plugins.find((entry) => entry.pluginId === "cycle.beta")?.status).toBe(
      "failed",
    );
    expect(
      harness.snapshot.plugins.find((entry) => entry.pluginId === "cycle.healthy")?.status,
    ).toBe("active");
  });

  it("ошибка активации не роняет ядро и включает safe mode", async () => {
    const root = registryRoot();

    writePlugin(root, {
      directory: "broken",
      id: "safe.broken",
      server: "export function activate() { throw new Error('boom'); }\n",
    });
    writePlugin(root, { directory: "healthy", id: "safe.healthy", server: EMPTY_ACTIVATE });

    const harness = await startFixtureHarness({
      provider: memoryProvider(),
      migrate: false,
      pluginDirectories: [root],
    });

    harnesses.push(harness);

    expect(harness.snapshot.started).toBe(true);
    expect(harness.snapshot.safeMode).toBe(true);
    expect(harness.snapshot.plugins.find((entry) => entry.pluginId === "safe.broken")?.status).toBe(
      "failed",
    );
    expect(
      harness.snapshot.plugins.find((entry) => entry.pluginId === "safe.healthy")?.status,
    ).toBe("active");
  });

  it("не оставляет регистрации после неудачной повторной активации", async () => {
    const root = registryRoot();

    writePlugin(root, {
      directory: "alpha",
      id: "restart.alpha",
      server: `
export function activate(context) {
  const metadata = {
    id: "restart.alpha.op",
    contract: "restart.alpha.commands.v1",
    version: 1,
    kind: "mutation",
    risk: "write",
    idempotency: "none",
    exposure: { ui: false, http: false, mcp: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: {}, additionalProperties: false },
  };

  context.commands.register({ metadata, handler: () => ({}) });
  if (globalThis.__kan008FailRestart === true) {
    throw new Error("restart failure");
  }
}
`,
    });

    const provider = memoryProvider();
    const first = await startFixtureHarness({
      provider,
      migrate: false,
      pluginDirectories: [root],
    });

    harnesses.push(first);
    expect(first.composition.operations.registry.has("restart.alpha.op")).toBe(true);

    await first.stop();
    expect(first.composition.operations.registry.has("restart.alpha.op")).toBe(false);

    (globalThis as typeof globalThis & { __kan008FailRestart?: boolean }).__kan008FailRestart =
      true;

    const second = await startFixtureHarness({
      provider,
      migrate: false,
      pluginDirectories: [root],
    });

    harnesses.push(second);

    expect(
      second.snapshot.plugins.find((entry) => entry.pluginId === "restart.alpha")?.status,
    ).toBe("failed");
    expect(second.composition.operations.registry.has("restart.alpha.op")).toBe(false);

    delete (globalThis as typeof globalThis & { __kan008FailRestart?: boolean })
      .__kan008FailRestart;
  });
});
