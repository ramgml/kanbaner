import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.missing-healthy");
}

export function deactivate() {
  record("deactivate", "fixture.missing-healthy");
}
