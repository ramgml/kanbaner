import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.db-broken");
}

export function deactivate() {
  record("deactivate", "fixture.db-broken");
  throw new Error("deactivation token=super-secret");
}
