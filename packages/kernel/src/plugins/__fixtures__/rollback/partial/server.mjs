import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.partial");
  throw new Error("partial activation failed");
}

export function deactivate() {
  record("deactivate", "fixture.partial");
}
