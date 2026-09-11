// A factory is also accepted, so a plugin can read options or the environment.
export default async () => ({
  name: "factory-tool",
  async detect() {
    return { available: true, location: "/factory" };
  },
  async backfill() {},
  async watch() {
    return () => {};
  },
});
