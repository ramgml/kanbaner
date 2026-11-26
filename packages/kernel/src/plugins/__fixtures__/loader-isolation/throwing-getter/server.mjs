const broken = {};

Object.defineProperty(broken, "activate", {
  get() {
    throw new Error("GETTER_MARKER token=super-secret");
  },
});

export default broken;
