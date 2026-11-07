import { cleanupE2EDataDirectory } from "./test-environment.ts";

/**
 * Удаляет изолированную E2E-базу.
 *
 * Playwright выполняет globalTeardown раньше teardown-а webServer-плагина,
 * поэтому первый проход — best-effort (на Linux удаление открытой базы
 * допустимо). Повторный проход на `exit` выполняется уже после SIGTERM,
 * custom drain и checkpoint сервера, и гарантирует очистку на Windows.
 */
export default function globalTeardown(): void {
  cleanupE2EDataDirectory();
  process.once("exit", cleanupE2EDataDirectory);
}
