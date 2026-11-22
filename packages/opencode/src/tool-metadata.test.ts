// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  OPENCODE_BUILTIN_TOOLS,
  OPENCODE_CATALOG_TOOLS,
  OPENCODE_MCP_TOOLS,
} from "./tool-metadata.ts";

interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

/** Минимальный JSONC reader для теста: убирает комментарии и trailing comma. */
function parseJsonc(source: string): unknown {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/gu, "$1"));
}

function config(): {
  readonly mcp: { readonly servers: Record<string, { readonly codemode?: boolean }> };
  readonly agents: {
    readonly kanbaner: {
      readonly mode: string;
      readonly system: string;
      readonly permissions: readonly PermissionRule[];
    };
  };
} {
  return parseJsonc(readFileSync(new URL("../../../opencode.jsonc", import.meta.url), "utf8")) as {
    mcp: { servers: Record<string, { codemode?: boolean }> };
    agents: {
      kanbaner: {
        mode: string;
        system: string;
        permissions: readonly PermissionRule[];
      };
    };
  };
}

const ALLOWED_BUILTINS = [
  "question",
  "websearch",
  "webfetch",
  "read",
  "glob",
  "grep",
  "edit",
  "shell",
  "subagent",
  "skill",
  "external_directory",
] as const;

describe("OpenCode tool metadata", () => {
  it("держит ordered deny * и явный allowlist built-ins и kanbaner_* в конфиге", () => {
    const parsed = config();
    const permissions = parsed.agents.kanbaner.permissions;

    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(permissions.filter((rule) => rule.effect === "deny")).toHaveLength(1);
    expect(
      permissions.filter((rule) => rule.effect === "allow").map((rule) => rule.action),
    ).toEqual([...ALLOWED_BUILTINS, "kanbaner_*"]);
    for (const rule of permissions) {
      expect(rule.resource).toBe("*");
      expect(["allow", "deny"]).toContain(rule.effect);
    }
  });

  it("не разрешает wildcard, Code Mode и сторонние MCP servers", () => {
    const parsed = config();
    const allows = parsed.agents.kanbaner.permissions.filter((rule) => rule.effect === "allow");

    expect(Object.keys(parsed.mcp.servers)).toEqual(["kanbaner"]);
    expect(allows.some((rule) => rule.action === "*")).toBe(false);
    for (const rule of allows) {
      expect(rule.action).not.toMatch(/^(browser|execute|orenda|webaccess|todowrite)/u);
    }
  });

  it("сохраняет Kanbaner MCP с codemode false и полным доступом built-ins", () => {
    const parsed = config();

    expect(parsed.mcp.servers.kanbaner?.codemode).toBe(false);
    expect(parsed.agents.kanbaner.mode).toBe("primary");
    expect(parsed.agents.kanbaner.system).toContain("expectedVersion");
    expect(parsed.agents.kanbaner.system.toLowerCase()).toContain("песочница");
  });

  it("совпадает с публичным catalog: 11 built-ins и 14 неизменных MCP tools", () => {
    expect(OPENCODE_BUILTIN_TOOLS.map((tool) => tool.name)).toEqual([...ALLOWED_BUILTINS]);
    for (const tool of OPENCODE_BUILTIN_TOOLS) {
      expect(tool.source).toBe("builtin");
      expect(tool.operationId).toBeUndefined();
    }

    expect(OPENCODE_MCP_TOOLS).toHaveLength(14);
    for (const tool of OPENCODE_MCP_TOOLS) {
      expect(tool.source).toBe("mcp");
      expect(tool.name.startsWith("kanbaner_")).toBe(true);
      expect(tool.operationId).toEqual(expect.stringMatching(/^kanbaner\./u));
    }

    expect(OPENCODE_CATALOG_TOOLS).toHaveLength(25);
    expect(OPENCODE_CATALOG_TOOLS).toEqual([...OPENCODE_BUILTIN_TOOLS, ...OPENCODE_MCP_TOOLS]);
  });
});
