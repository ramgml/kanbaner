import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.db-base");
}

export function deactivate() {
  record("deactivate", "fixture.db-base");
}
