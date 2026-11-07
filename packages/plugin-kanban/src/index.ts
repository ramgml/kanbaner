import type { PluginActivationServices } from "@kanbaner/plugin-sdk";

import { KANBAN_PLUGIN_ID, kanbanUiContributions } from "./metadata.ts";

export {
  KANBAN_COLUMN_ORDER,
  KANBAN_PLUGIN_ID,
  KANBAN_ROUTE,
  KANBAN_UI_CONTRACT,
  kanbanUiContributions,
} from "./metadata.ts";

/** Публичный контекст активации без импорта kernel. */
export interface KanbanActivationContext extends PluginActivationServices {
  readonly pluginId: string;
}

/**
 * Регистрирует только UI-метаданные.
 *
 * Доменной логики, хранилища и кэша в плагине канбана нет: задачи читаются и
 * изменяются через публичные команды и запросы `kanbaner.tasks`.
 */
export async function activate(context: KanbanActivationContext): Promise<void> {
  if (context.pluginId !== KANBAN_PLUGIN_ID) {
    throw new Error("Активация kanbaner.kanban получила другой Plugin ID");
  }

  context.ui.register(kanbanUiContributions);
}

/** Данные задач принадлежат `kanbaner.tasks`; отключение канбана их не удаляет. */
export async function deactivate(): Promise<void> {
  // Намеренно пусто.
}
