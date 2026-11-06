import { record } from "../../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.prerelease-provider");
}

export function deactivate() {
  record("deactivate", "fixture.prerelease-provider");
}
