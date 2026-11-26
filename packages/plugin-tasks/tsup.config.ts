import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/contract.ts", "src/testing.ts"],
  format: ["esm"],
  target: "node24",
  // Каждый entrypoint собирается отдельно: client-safe `contract.js` не должен
  // делить чанки с серверным `index.js` и его Store/operations.
  splitting: false,
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@kanbaner/plugin-sdk", "@sinclair/typebox"],
});
