"use server";

import { revalidatePath } from "next/cache";

import type { PluginManagerActionResult } from "../lib/plugin-manager-types";
import { getPluginService, PluginServiceError } from "./plugin-service";

function failure(code: string, message: string): PluginManagerActionResult {
  return {
    ok: false,
    state: null,
    error: { code, message },
  };
}

function toFailure(error: unknown): PluginManagerActionResult {
  if (error instanceof PluginServiceError) {
    return failure(error.code, error.message);
  }

  return failure("INTERNAL_ERROR", "Не удалось изменить состояние плагина");
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
    return toFailure(error);
  }
}

export async function refreshPluginsAction(): Promise<PluginManagerActionResult> {
  try {
    const state = await getPluginService().refresh();

    revalidatePath("/", "layout");

    return { ok: true, state, error: null };
  } catch (error) {
    return toFailure(error);
  }
}
