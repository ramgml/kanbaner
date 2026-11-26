import { record } from "../../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.dup");
}

export function deactivate() {
  record("deactivate", "fixture.dup");
}
