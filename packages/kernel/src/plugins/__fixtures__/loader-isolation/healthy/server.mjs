import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.loader-healthy");
}

export function deactivate() {
  record("deactivate", "fixture.loader-healthy");
}
