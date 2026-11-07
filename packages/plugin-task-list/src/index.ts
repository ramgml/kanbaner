import type { PluginActivationServices } from "@kanbaner/plugin-sdk";

import { TASK_LIST_PLUGIN_ID, taskListUiContributions } from "./metadata.ts";

export {
  TASK_LIST_PLUGIN_ID,
  TASK_LIST_ROUTE,
  TASK_LIST_UI_CONTRACT,
  taskListUiContributions,
} from "./metadata.ts";

/** Публичный контекст активации без импорта kernel. */
export interface TaskListActivationContext extends PluginActivationServices {
  readonly pluginId: string;
}

/**
 * Регистрирует только UI-метаданные.
 *
 * Доменной логики, хранилища и кэша в плагине списка нет: все данные
 * приходят через публичные команды и запросы `kanbaner.tasks`.
 */
export async function activate(context: TaskListActivationContext): Promise<void> {
  if (context.pluginId !== TASK_LIST_PLUGIN_ID) {
    throw new Error("Активация kanbaner.task-list получила другой Plugin ID");
  }

  context.ui.register(taskListUiContributions);
}

/** Данные задач принадлежат `kanbaner.tasks`; отключение списка их не удаляет. */
export async function deactivate(): Promise<void> {
  // Намеренно пусто.
}
