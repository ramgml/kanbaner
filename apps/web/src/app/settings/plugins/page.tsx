import { PluginManager } from "../../../components/plugins/plugin-manager";
import { getPluginManagerState } from "../../../server/plugin-service";

export const dynamic = "force-dynamic";

export default async function SettingsPluginsPage() {
  const state = await getPluginManagerState();

  return <PluginManager initialState={state} />;
}
