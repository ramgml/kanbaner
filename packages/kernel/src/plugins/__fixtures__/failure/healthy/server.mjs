import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.healthy");
}

export function deactivate() {
  record("deactivate", "fixture.healthy");
}
