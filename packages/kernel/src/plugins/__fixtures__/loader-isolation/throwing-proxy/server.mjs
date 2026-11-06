const broken = new Proxy(
  {},
  {
    get() {
      throw new Error("PROXY_MARKER token=super-secret");
    },
  },
);

export default broken;
