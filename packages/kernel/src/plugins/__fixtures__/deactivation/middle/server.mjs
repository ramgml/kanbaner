import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.deactivation-middle");
}

export function deactivate() {
  record("deactivate", "fixture.deactivation-middle");
}
