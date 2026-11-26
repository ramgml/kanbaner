import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.safe-a");
}

export function deactivate() {
  record("deactivate", "fixture.safe-a");
}
