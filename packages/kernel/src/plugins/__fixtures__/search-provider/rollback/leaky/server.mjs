import { record } from "../../../shared/records.mjs";

const provider = {
  id: "fixture.search-leaky",
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
  record("activate", "fixture.search-leaky");
  context.search.registerProvider(provider);
  throw new Error("activation failed после регистрации провайдера");
}

export function deactivate() {
  record("deactivate", "fixture.search-leaky");
}
