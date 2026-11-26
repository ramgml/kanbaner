import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.loader-dependent");
}

export function deactivate() {
  record("deactivate", "fixture.loader-dependent");
}
