import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplicationComposition } from "../src/server/composition-root.ts";

const dataDirectory = mkdtempSync(join(tmpdir(), "kanbaner-composition-check-"));
const composition = await createApplicationComposition({ storage: { dataDirectory } });

try {
  if (composition.plugins.length !== 0) {
    throw new Error("Production composition не должен подключать fixture-плагин.");
  }

  console.log(
    [
      "Composition root запущен.",
      `kernel API: ${String(composition.kernel.apiVersion)}`,
      `Plugin Contract: ${composition.kernel.pluginContractVersion}`,
      `storageProvider: ${composition.storageProvider.backendId}`,
      "shared services: events, resources, links, operations, ui",
      "plugins: 0",
    ].join(" "),
  );
} finally {
  await composition.close();
  rmSync(dataDirectory, { recursive: true, force: true });
}
