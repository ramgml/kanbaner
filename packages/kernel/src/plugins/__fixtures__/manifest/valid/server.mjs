import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.valid");
}

export function deactivate() {
  record("deactivate", "fixture.valid");
}
