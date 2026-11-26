import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.version-healthy");
}

export function deactivate() {
  record("deactivate", "fixture.version-healthy");
}
