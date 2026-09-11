import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAdapter, loadPlugins } from "./plugins.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const f = (name: string) => join(fixtures, name);

describe("loadPlugins", () => {
  it("loads a plain adapter object from a file path, and it works", async () => {
    const { adapters, errors } = await loadPlugins([f("plugin-object.mjs")]);
    expect(errors).toEqual([]);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.name).toBe("my-tool");
    expect(await adapters[0]!.detect()).toMatchObject({ available: true, location: "/somewhere/my-tool.log" });

    const emitted: Array<{ id: string }> = [];
    await adapters[0]!.backfill((e) => emitted.push(e as never));
    expect(emitted.map((e) => e.id)).toEqual(["my-tool:1"]);
    expect(typeof (await adapters[0]!.watch(() => {}))).toBe("function");
  });

  it("accepts a factory and a class as well as an object", async () => {
    const { adapters, errors } = await loadPlugins([f("plugin-factory.mjs"), f("plugin-class.mjs")]);
    expect(errors).toEqual([]);
    expect(adapters.map((a) => a.name)).toEqual(["factory-tool", "class-tool"]);
  });

  it("reports and skips broken plugins without losing the good ones", async () => {
    const { adapters, errors } = await loadPlugins([
      f("plugin-not-an-adapter.mjs"),
      f("plugin-throws.mjs"),
      f("plugin-object.mjs"),
      f("plugin-missing.mjs"),
    ]);
    expect(adapters.map((a) => a.name)).toEqual(["my-tool"]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/not an Adapter/);
    expect(errors[1]).toMatch(/boom while loading/);
    expect(errors[2]).toMatch(/plugin-missing/);
  });

  it("loads nothing, quietly, when no plugins are configured", async () => {
    expect(await loadPlugins([])).toEqual({ adapters: [], errors: [] });
  });

  it("isAdapter rejects near-misses", () => {
    const ok = { name: "x", detect: () => {}, backfill: () => {}, watch: () => {} };
    expect(isAdapter(ok)).toBe(true);
    expect(isAdapter({ ...ok, name: "" })).toBe(false);
    expect(isAdapter({ ...ok, watch: undefined })).toBe(false);
    expect(isAdapter(null)).toBe(false);
    expect(isAdapter("nope")).toBe(false);
  });
});
