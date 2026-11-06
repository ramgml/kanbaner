import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.missing-dependent");
}

export function deactivate() {
  record("deactivate", "fixture.missing-dependent");
}
