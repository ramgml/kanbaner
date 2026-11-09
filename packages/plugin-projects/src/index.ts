import type { PluginActivationServices } from "@kanbaner/plugin-sdk";

import { PROJECTS_PLUGIN_ID, projectsUiContributions } from "./metadata.ts";

export {
  KANBAN_COLUMN_ORDER,
  KANBAN_ROUTE,
  PROJECTS_OVERVIEW_ROUTE,
  PROJECTS_PLUGIN_ID,
  PROJECTS_UI_CONTRACT,
  PROJECT_ROUTES,
  TASK_LIST_ROUTE,
  projectsUiContributions,
  type ProjectRoute,
} from "./metadata.ts";

/** Публичный контекст активации без импорта kernel. */
export interface ProjectsActivationContext extends PluginActivationServices {
  readonly pluginId: string;
}

/**
 * Регистрирует только UI-метаданные.
 *
 * Доменной логики, хранилища и кэша в плагине проектов нет: проекты, задачи и
 * сводки читаются и изменяются через публичные команды и запросы
 * `kanbaner.tasks`.
 */
export async function activate(context: ProjectsActivationContext): Promise<void> {
  if (context.pluginId !== PROJECTS_PLUGIN_ID) {
    throw new Error("Активация kanbaner.projects получила другой Plugin ID");
  }

  context.ui.register(projectsUiContributions);
}

/** Данные задач принадлежат `kanbaner.tasks`; отключение UI их не удаляет. */
export async function deactivate(): Promise<void> {
  // Намеренно пусто.
}
