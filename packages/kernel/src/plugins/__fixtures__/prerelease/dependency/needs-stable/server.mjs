import { record } from "../../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.needs-stable");
}

export function deactivate() {
  record("deactivate", "fixture.needs-stable");
}
