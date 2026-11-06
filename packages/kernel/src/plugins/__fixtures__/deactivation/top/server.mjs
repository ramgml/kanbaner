import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.deactivation-top");
}

export function deactivate() {
  record("deactivate", "fixture.deactivation-top");
}
