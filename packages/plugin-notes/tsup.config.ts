import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/contract.ts", "src/ui.tsx"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@kanbaner/plugin-sdk",
    "@kanbaner/markdown-ui",
    "@sinclair/typebox",
    "mdast-util-from-markdown",
    "@milkdown/kit",
  ],
});
