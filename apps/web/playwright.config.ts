import { defineConfig } from "@playwright/test";

import { E2E_BASE_URL, E2E_DATA_DIR, E2E_PLUGIN_DIRS, E2E_PORT } from "./e2e/test-environment.ts";

export default defineConfig({
  testDir: "./e2e",
  // node_modules исключён из репозитория и из Prettier по умолчанию.
  outputDir: "node_modules/.playwright-results",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    viewport: { width: 360, height: 740 },
    trace: "retain-on-failure",
  },
  webServer: {
    // Тот же production custom server, что и `pnpm start`: SIGTERM останавливает
    // приём запросов, дожидается активных и выполняет storage checkpoint.
    command: "node scripts/server.mjs",
    url: E2E_BASE_URL,
    name: "kanbaner",
    stdout: "pipe",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    env: {
      ...process.env,
      NODE_ENV: "production",
      KANBANER_HOST: "127.0.0.1",
      KANBANER_PORT: String(E2E_PORT),
      KANBANER_DATA_DIR: E2E_DATA_DIR,
      KANBANER_PLUGIN_DIRS: E2E_PLUGIN_DIRS,
      KANBANER_DISABLED_PLUGINS: "",
      KANBANER_SHUTDOWN_TIMEOUT_MS: "15000",
    },
  },
});
