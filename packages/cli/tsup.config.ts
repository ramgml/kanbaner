import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node24",
  splitting: false,
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@kanbaner/plugin-notes/contract",
    "@kanbaner/plugin-sdk",
    "@kanbaner/plugin-tasks/contract",
  ],
});
