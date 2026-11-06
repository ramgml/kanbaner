import { record } from "../../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.needs-prerelease");
}

export function deactivate() {
  record("deactivate", "fixture.needs-prerelease");
}
