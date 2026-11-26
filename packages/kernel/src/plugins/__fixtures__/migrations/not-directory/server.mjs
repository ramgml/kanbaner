import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.migrations-not-directory");
}

export function deactivate() {
  record("deactivate", "fixture.migrations-not-directory");
}
