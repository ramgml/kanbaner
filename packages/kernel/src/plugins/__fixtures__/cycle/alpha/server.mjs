import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.cycle-alpha");
}

export function deactivate() {
  record("deactivate", "fixture.cycle-alpha");
}
