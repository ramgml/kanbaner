import { record } from "../../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.host-stable");
}

export function deactivate() {
  record("deactivate", "fixture.host-stable");
}
