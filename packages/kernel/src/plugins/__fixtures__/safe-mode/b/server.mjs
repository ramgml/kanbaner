import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.safe-b");
}

export function deactivate() {
  record("deactivate", "fixture.safe-b");
}
