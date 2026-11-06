import { record } from "../../shared/records.mjs";

export function activate() {
  record("activate", "fixture.needs2");
}

export function deactivate() {
  record("deactivate", "fixture.needs2");
}
