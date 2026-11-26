import { record } from "../../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.dup-healthy");
}

export function deactivate() {
  record("deactivate", "fixture.dup-healthy");
}
