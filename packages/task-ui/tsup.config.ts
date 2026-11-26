import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // React и контракт задач поставляет приложение: библиотека не должна
  // создавать вторую копию React или серверный entrypoint задач.
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@kanbaner/plugin-tasks",
    "@kanbaner/plugin-sdk",
  ],
});
