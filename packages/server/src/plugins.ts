import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter } from "@ai-usage-widget/core";

/**
 * Loads third-party adapters named in `config.plugins`.
 *
 * The contract is deliberately tiny, so writing one is a single file:
 *
 *   export default {
 *     name: "my-tool",
 *     async detect() { return { available: true, location: "..." } },
 *     async backfill(emit) { ... },
 *     async watch(emit) { return () => {} },
 *   }
 *
 * A default export may also be a factory (sync or async) returning that
 * object, or a class to be constructed. Anything that does not end up looking
 * like an Adapter is reported and skipped: one bad plugin must never stop the
 * collector from reading the user's other tools.
 */

export function isAdapter(v: unknown): v is Adapter {
  const a = v as Adapter | null;
  return !!a && typeof a === "object" && typeof a.name === "string" && a.name.length > 0
    && typeof a.detect === "function" && typeof a.backfill === "function" && typeof a.watch === "function";
}

function specifierToUrl(spec: string): string {
  const local = spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : spec;
  if (local.startsWith(".") || isAbsolute(local)) return pathToFileURL(resolve(local)).href;
  return local; // bare package name: let Node resolve it
}

/** Never throws. Returns the adapters that loaded, plus a message per failure. */
export async function loadPlugins(specs: string[]): Promise<{ adapters: Adapter[]; errors: string[] }> {
  const adapters: Adapter[] = [];
  const errors: string[] = [];
  for (const spec of specs) {
    try {
      const mod: any = await import(specifierToUrl(spec));
      const exported = mod.default ?? mod.adapter ?? mod.createAdapter ?? mod;
      let instance: unknown = exported;
      if (typeof exported === "function") {
        try {
          instance = await exported();
        } catch {
          // A class cannot be called without `new`; try that before giving up.
          instance = new exported();
        }
      }
      if (isAdapter(instance)) adapters.push(instance);
      else errors.push(`${spec}: default export is not an Adapter (needs name, detect, backfill, watch)`);
    } catch (e) {
      errors.push(`${spec}: ${(e as Error).message}`);
    }
  }
  return { adapters, errors };
}
