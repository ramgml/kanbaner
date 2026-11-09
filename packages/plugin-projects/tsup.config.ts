import { defineConfig } from "tsup";

export default defineConfig({
  // Серверный entrypoint регистрирует только metadata; UI entrypoint несёт
  // React-рендереры и собирается отдельным файлом без общих серверных чанков.
  entry: ["src/index.ts", "src/ui.tsx"],
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
    "@kanbaner/plugin-tasks",
    "@kanbaner/task-ui",
  ],
});
