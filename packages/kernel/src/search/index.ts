/**
 * Поисковый сервис ядра.
 *
 * Локальная точка входа не содержит доменных типов и backend-специфичного
 * кода: только привязку публичного SearchIndexStore к plugin ID.
 */
export { bindPluginSearch } from "./binding.ts";
export { createSearchService, KernelSearchService } from "./search-service.ts";
