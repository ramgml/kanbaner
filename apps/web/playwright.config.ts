import path from "node:path";

import { defineConfig } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // node_modules исключён из репозитория и из Prettier по умолчанию.
  outputDir: "node_modules/.playwright-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    viewport: { width: 360, height: 740 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      KANBANER_PLUGIN_DIRS: path.join(import.meta.dirname, "e2e/fixtures/plugins"),
      KANBANER_DISABLED_PLUGINS: "",
    },
  },
});
