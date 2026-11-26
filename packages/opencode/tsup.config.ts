import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ui.tsx", "src/mcp.ts"],
  format: ["esm"],
  target: "node24",
  splitting: false,
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@kanbaner/plugin-sdk",
    "@modelcontextprotocol/sdk",
    "@opencode/client",
    "@opencode/client/service",
    "lucide-react",
    "react",
    "react-dom",
    "zod",
  ],
});
