import { rmSync } from "node:fs";
import path from "node:path";

const appDirectory = path.join(import.meta.dirname, "..");
const nodeModulesDirectory = path.join(appDirectory, "node_modules");

/** Порт E2E-сервера; совпадает с baseURL в playwright.config.ts. */
export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * Изолированный каталог данных текущего E2E-прогона.
 *
 * Уникальный суффикс не даёт упавшему предыдущему прогону оставить состояние,
 * которое повлияет на Radix Switch и другие тесты. Каталог живёт внутри
 * `node_modules`, поэтому не пересекается с пользовательским
 * `~/.local/share/kanbaner/data` (Linux) или `%APPDATA%\Kanbaner\data`
 * (Windows).
 */
export const E2E_DATA_DIR = path.join(
  nodeModulesDirectory,
  ".playwright-data",
  `${process.pid}-${Date.now()}`,
);

export const E2E_PLUGIN_DIRS = path.join(appDirectory, "e2e", "fixtures", "plugins");

if (!E2E_DATA_DIR.startsWith(`${nodeModulesDirectory}${path.sep}`)) {
  throw new Error(`E2E data directory must stay inside apps/web/node_modules: ${E2E_DATA_DIR}`);
}

/**
 * Удаляет тестовую БД.
 *
 * Вызывается из globalTeardown, который Playwright выполняет до остановки
 * webServer-плагина, и повторно на `exit` — уже после graceful shutdown и
 * checkpoint. На Windows открытая база может не удалиться в первом проходе,
 * поэтому ошибки не пробрасываются, а финальная очистка гарантирована на
 * завершении процесса.
 */
export function cleanupE2EDataDirectory(): void {
  try {
    rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Финальная попытка выполняется на exit после остановки сервера.
  }
}
