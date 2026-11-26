import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.future");
}

export function deactivate() {
  record("deactivate", "fixture.future");
}
