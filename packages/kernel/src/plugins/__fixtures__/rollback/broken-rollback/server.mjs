import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.broken-rollback");
  throw new Error("activation token=super-secret");
}

export function deactivate() {
  record("deactivate", "fixture.broken-rollback");
  throw new Error("rollback token=super-secret");
}
