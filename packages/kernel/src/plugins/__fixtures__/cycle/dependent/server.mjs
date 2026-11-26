import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.cycle-dependent");
}

export function deactivate() {
  record("deactivate", "fixture.cycle-dependent");
}
