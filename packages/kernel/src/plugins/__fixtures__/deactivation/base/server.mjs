import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.deactivation-base");
}

export function deactivate() {
  record("deactivate", "fixture.deactivation-base");
}
