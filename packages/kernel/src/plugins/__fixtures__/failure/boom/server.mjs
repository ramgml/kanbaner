import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.boom");
  throw new Error("boom token=super-secret /home/private/path");
}

export function deactivate() {
  record("deactivate", "fixture.boom");
}
