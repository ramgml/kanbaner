import { record } from "../../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.host-prerelease");
}

export function deactivate() {
  record("deactivate", "fixture.host-prerelease");
}
