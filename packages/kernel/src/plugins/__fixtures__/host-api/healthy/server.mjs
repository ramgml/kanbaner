import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.host-healthy");
}

export function deactivate() {
  record("deactivate", "fixture.host-healthy");
}
