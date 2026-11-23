// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { EnsureOptions } from "@opencode/client/service";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn<(options: EnsureOptions) => Promise<{ url: string }>>(async () => ({
    url: "http://127.0.0.1:4096",
  })),
  headers: vi.fn(() => ({ authorization: "Bearer test" })),
  make: vi.fn(() => ({})),
}));

vi.mock("@opencode/client/service", () => ({
  Service: { ensure: mocks.ensure, headers: mocks.headers },
}));

vi.mock("@opencode/client", () => ({
  OpenCode: { make: mocks.make },
}));

import { ensureOpenCodeGateway } from "./gateway.ts";

describe("ensureOpenCodeGateway", () => {
  it("принимает Service major 2.x, но не 1.x/3.x и malformed-версии", async () => {
    await ensureOpenCodeGateway();

    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    const options = mocks.ensure.mock.calls[0]?.[0];
    expect(options?.version).toBeTypeOf("function");
    const accepts = options?.version as (version: string) => boolean;

    for (const version of ["2.0.0", "2.2.5", "2.3.0", "2.3.1-beta.1", "2.10.3+build.5"]) {
      expect(accepts(version), version).toBe(true);
    }
    for (const version of [
      "",
      "2",
      "2.",
      "2.foo",
      "2.3",
      "2.3.1-",
      "1.9.0",
      "3.0.0",
      "20.0.0",
      "v2.3.0",
      "2.03.1",
      "2.3.01",
      "2.3.1-01",
      "2.3.1-alpha.01",
      "2.3.1+build..5",
      "2.3.1 ",
      "2.3.1\n",
    ]) {
      expect(accepts(version), version).toBe(false);
    }
  });
});
