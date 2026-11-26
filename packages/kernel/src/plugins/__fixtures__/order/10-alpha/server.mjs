import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.alpha");
}

export function deactivate() {
  record("deactivate", "fixture.alpha");
}
