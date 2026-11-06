const KEY = "__kanbanerKernelFixtureRecords";

function store() {
  const holder = globalThis;

  if (holder[KEY] === undefined) {
    holder[KEY] = { events: [] };
  }

  return holder[KEY];
}

export function record(kind, id) {
  store().events.push(`${kind}:${id}`);
}
