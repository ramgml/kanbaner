import { redirect } from "next/navigation";

import { SETTINGS_PLUGINS_HREF } from "../../components/shell/nav-items";

/**
 * Старый адрес plugin manager. Управление плагинами перенесено в настройки,
 * поэтому `/plugins` остаётся совместимым входом через redirect.
 */
export default function PluginsPage() {
  redirect(SETTINGS_PLUGINS_HREF);
}
