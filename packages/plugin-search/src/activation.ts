import type { PluginActivationServices, PluginId, SearchProviderQuery } from "@kanbaner/plugin-sdk";

import { SEARCH_PLUGIN_ID, SEARCH_QUERY_IDS } from "./constants.ts";
import { searchUiContributions } from "./metadata.ts";
import { SEARCH_QUERY_LIST } from "./operations.ts";
import type { SearchQueryInput } from "./schemas.ts";

/**
 * Контекст активации search-плагина.
 *
 * Плагин не получает pluginId самостоятельно: его передаёт доверенный
 * runtime. Остальные сервисы — публичный bound-фасад SDK.
 */
export interface SearchActivationContext extends PluginActivationServices {
  readonly pluginId: PluginId;
}

function toProviderQuery(input: SearchQueryInput): SearchProviderQuery {
  return {
    text: input.text,
    ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
  };
}

/**
 * Активирует headless-плагин глобального поиска.
 *
 * Регистрирует только read-only queries и UI-метаданные. Агрегация и
 * переиндексация принадлежат провайдерам доменов: search не вызывает чужие
 * команды и не выполняет межплагинных мутаций.
 */
export async function activate(context: SearchActivationContext): Promise<void> {
  if (context.pluginId !== SEARCH_PLUGIN_ID) {
    throw new Error("Активация kanbaner.search получила другой Plugin ID");
  }

  for (const metadata of SEARCH_QUERY_LIST) {
    if (metadata.id === SEARCH_QUERY_IDS.query) {
      context.queries.register({
        metadata,
        handler: (input) => context.search.aggregate(toProviderQuery(input as SearchQueryInput)),
      });
      continue;
    }

    if (metadata.id === SEARCH_QUERY_IDS.filters) {
      context.queries.register({
        metadata,
        handler: () => context.search.listFacets(),
      });
      continue;
    }

    throw new Error(`Нет обработчика запроса ${metadata.id}`);
  }

  context.ui.register(searchUiContributions);
}

/** Данные не удаляются при деактивации; runtime снимает регистрации сам. */
export async function deactivate(): Promise<void> {
  // Намеренно пусто: поиск не владеет доменными данными.
}
