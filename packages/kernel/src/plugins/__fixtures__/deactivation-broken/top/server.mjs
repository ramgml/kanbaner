import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.db-top");
}

export function deactivate() {
  record("deactivate", "fixture.db-top");
}
