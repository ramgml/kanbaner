/**
 * Production test hook: держит транзакцию открытой, пока не придёт SIGTERM.
 *
 * Hook запускается внутри custom server после listen. Он загружает app
 * storage обычным HTTP-запросом, затем начинает транзакцию с отложенным
 * commit. Shutdown обязан дождаться её и выполнить checkpoint.
 */
export default async function deferredShutdown({ port }) {
  const response = await fetch(`http://127.0.0.1:${port}/plugins`);

  if (!response.ok) {
    throw new Error(`Smoke request failed: ${response.status}`);
  }

  await response.text();

  const entry = globalThis.__kanbanerWebStorageRuntimeV1;

  if (entry === undefined) {
    throw new Error("Storage runtime singleton is not registered");
  }

  const runtime = await entry.promise;
  let release;

  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const transaction = runtime.provider.withTransaction(async (tx) => {
    await tx.documents.put({
      pluginId: "test.shutdown",
      collection: "deferred",
      id: "01JSHDN000000000000000000001",
      data: { state: "written-before-shutdown" },
      expectedVersion: 0,
    });
    process.stdout.write("TEST_DEFERRED_STARTED\n");
    await gate;
  });

  // Даём сигналу прийти во время открытой транзакции, затем отпускаем её.
  setTimeout(() => {
    release();
  }, 700);

  globalThis.__kanbanerTestDeferredTransaction = transaction;
}
