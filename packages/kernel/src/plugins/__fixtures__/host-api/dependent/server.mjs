import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.host-dependent");
}

export function deactivate() {
  record("deactivate", "fixture.host-dependent");
}
