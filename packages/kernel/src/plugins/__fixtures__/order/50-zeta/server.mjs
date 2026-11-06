import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.zeta");
}

export function deactivate() {
  record("deactivate", "fixture.zeta");
}
