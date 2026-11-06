import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.provider");
}

export function deactivate() {
  record("deactivate", "fixture.provider");
}
