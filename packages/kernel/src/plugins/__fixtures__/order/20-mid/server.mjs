import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.mid");
}

export function deactivate() {
  record("deactivate", "fixture.mid");
}
