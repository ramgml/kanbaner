import { record } from "../../shared/records.mjs";

const GATES_KEY = "__kanbanerKernelFixtureGates";

function gate(name) {
  const holder = globalThis;
  const gates = holder[GATES_KEY];

  return gates === undefined ? undefined : gates.get(name);
}

async function waitForGate(name) {
  const pending = gate(name);

  if (pending !== undefined) {
    await pending.promise;
  }
}

export async function activate() {
  record("activate", "fixture.concurrency");
  await waitForGate("activate");
}

export async function deactivate() {
  record("deactivate", "fixture.concurrency");
  await waitForGate("deactivate");
}
