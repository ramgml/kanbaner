import { record } from "../../../shared/records.mjs";

const provider = {
  id: "fixture.search-stable",
  kinds: [{ id: "item", title: "Элементы" }],
  filterFields: [],
  async listFacets() {
    return [];
  },
  async search() {
    return [];
  },
  async reindex() {
    return 0;
  },
};

export function activate(context) {
  record("activate", "fixture.search-stable");
  context.search.registerProvider(provider);
}

export function deactivate() {
  record("deactivate", "fixture.search-stable");
}
