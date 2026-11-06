import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.dependent");
}

export function deactivate() {
  record("deactivate", "fixture.dependent");
}
