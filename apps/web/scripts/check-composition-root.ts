import { createApplicationComposition } from "../src/server/composition-root.ts";

const composition = createApplicationComposition();

if (composition.storageProvider !== null || composition.plugins.length !== 0) {
  throw new Error("Каркас KAN-001 не должен регистрировать Storage Provider или плагины.");
}

console.log(
  [
    "Composition root запущен.",
    `kernel API: ${String(composition.kernel.apiVersion)}`,
    `Plugin Contract: ${composition.kernel.pluginContractVersion}`,
    "storageProvider: null",
    "plugins: 0",
  ].join(" "),
);
