// Lets plain Node run the Worker's TypeScript, which imports "../lib/audit"
// without an extension (a bundler resolves that; Node does not).
//   node --import ./tools/ts-resolve.mjs --experimental-strip-types tools/x.ts
// Used by `npm run pin:set`. Relative specifiers only: try <name>.ts, then <name>/index.ts.
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) register(import.meta.url);

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw err;
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await next(candidate, context);
      } catch {
        // try the next spelling
      }
    }
    throw err;
  }
}
