import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.cycle-healthy");
}

export function deactivate() {
  record("deactivate", "fixture.cycle-healthy");
}
