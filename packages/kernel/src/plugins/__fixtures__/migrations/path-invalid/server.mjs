import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.migrations-path-invalid");
}

export function deactivate() {
  record("deactivate", "fixture.migrations-path-invalid");
}
