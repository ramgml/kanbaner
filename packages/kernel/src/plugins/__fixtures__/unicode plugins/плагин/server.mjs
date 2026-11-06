import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.unicode");
}

export function deactivate() {
  record("deactivate", "fixture.unicode");
}
