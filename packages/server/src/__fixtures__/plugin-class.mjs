// A class is accepted too: it is constructed with no arguments.
export default class ClassTool {
  name = "class-tool";
  async detect() {
    return { available: false, reason: "nothing installed" };
  }
  async backfill() {}
  async watch() {
    return () => {};
  }
}
