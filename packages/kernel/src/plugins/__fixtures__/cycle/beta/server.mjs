import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.cycle-beta");
}

export function deactivate() {
  record("deactivate", "fixture.cycle-beta");
}
