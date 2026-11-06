"use server";

import { revalidatePath } from "next/cache";

import type { PluginManagerActionResult, PluginManagerState } from "../lib/plugin-manager-types";
import { getPluginService, PluginServiceError } from "./plugin-service";

const INTERNAL_ERROR_MESSAGE = "Не удалось изменить состояние плагина";

function failure(
  code: string,
  message: string,
  state: PluginManagerState | null = null,
): PluginManagerActionResult {
  return {
    ok: false,
    state,
    error: { code, message },
  };
}

function toFailure(error: unknown): PluginManagerActionResult {
  if (error instanceof PluginServiceError) {
    return failure(error.code, error.message, error.state);
  }

  // Произвольный текст исключения не выходит за пределы сервера.
  return failure("INTERNAL_ERROR", INTERNAL_ERROR_MESSAGE);
}

function revalidateIfChanged(state: PluginManagerState | null): void {
  if (state === null) {
    return;
  }

  try {
    revalidatePath("/", "layout");
  } catch {
    // Инвалидация RSC не должна скрывать безопасный результат действия.
  }
}

export async function setPluginEnabledAction(
  pluginId: string,
  enabled: boolean,
): Promise<PluginManagerActionResult> {
  if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
    return failure("VALIDATION_ERROR", "Неверный идентификатор плагина");
  }

  if (typeof enabled !== "boolean") {
    return failure("VALIDATION_ERROR", "Неверное состояние плагина");
  }

  try {
    const state = await getPluginService().setPluginEnabled(pluginId.trim(), enabled);

    // Runtime использует stop() + новый start(): текущая страница получает
    // свежий RSC payload без полной перезагрузки браузера.
    revalidatePath("/", "layout");

    return { ok: true, state, error: null };
  } catch (error) {
    const result = toFailure(error);

    // При неудачной деактивации runtime уже остановлен: layout должен
    // получить stopped snapshot, а не старое активное состояние.
    revalidateIfChanged(result.state);

    return result;
  }
}

export async function refreshPluginsAction(): Promise<PluginManagerActionResult> {
  try {
    const state = await getPluginService().refresh();

    revalidatePath("/", "layout");

    return { ok: true, state, error: null };
  } catch (error) {
    const result = toFailure(error);

    revalidateIfChanged(result.state);

    return result;
  }
}
