// build-ui.mjs — make the Worker's copy of the page from src/Index.html.
//
//   node ops/tools/build-ui.mjs            writes ops/public/index.html
//   node ops/tools/build-ui.mjs --stdout   prints the page instead
//
// Built-ins only: the root test suites import this with no node_modules.
//
// Changes from the source, and nothing else:
//   1. /transport.js is loaded before the page's own script;
//   2. the shopping, suppliers and products entries leave MORE_ITEMS
//      (those screens are not being moved);
//   3. Apps Script template tags are resolved. src/Index.html has none today
//      (doGet serves it with no injected values); the build still refuses to
//      emit any "<?", because the Apps Script template engine opens a
//      scriptlet on "<?" even inside a JS string or comment.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src/Index.html");
const OUT = resolve(HERE, "../public/index.html");

export const REMOVED_TABS = ["shopping", "suppliers", "products"];
const TRANSPORT_TAG = '<script src="/transport.js"></script>';

function removeMoreItems(source) {
  const lines = source.split("\n");
  for (const tab of REMOVED_TABS) {
    // Find the array afresh each time: removing a line moves its end.
    const start = lines.findIndex((l) => /^\s*const MORE_ITEMS = \[\s*$/.test(l));
    if (start === -1) throw new Error("build-ui: cannot find MORE_ITEMS");
    const end = lines.findIndex((l, i) => i > start && /^\s*\];\s*$/.test(l));
    if (end === -1) throw new Error("build-ui: MORE_ITEMS is not closed");
    const hits = [];
    for (let i = start + 1; i < end; i++) {
      if (new RegExp(`^\\s*\\{\\s*tab:\\s*'${tab}'`).test(lines[i])) hits.push(i);
    }
    if (hits.length !== 1) {
      throw new Error(`build-ui: expected exactly one '${tab}' entry in MORE_ITEMS, found ${hits.length}`);
    }
    if (!/\},\s*$/.test(lines[hits[0]])) throw new Error(`build-ui: the '${tab}' entry is not a single line`);
    lines.splice(hits[0], 1);
  }
  return lines.join("\n");
}

function addTransport(html) {
  // The page's own script is the first <script> without a src.
  const m = /^([ \t]*)<script(?![^>]*\bsrc=)[^>]*>/m.exec(html);
  if (!m) throw new Error("build-ui: cannot find the page's inline <script>");
  return html.slice(0, m.index) + m[1] + TRANSPORT_TAG + "\n" + html.slice(m.index);
}

/**
 * Build the page. `write` (default false) also writes ops/public/index.html.
 * `source` replaces the contents of src/Index.html, for tests.
 */
export function buildUi({ write = false, source } = {}) {
  const input = source ?? readFileSync(SRC, "utf8");
  const html = addTransport(removeMoreItems(input));
  const left = html.indexOf("<?");
  if (left !== -1) {
    const line = html.slice(0, left).split("\n").length;
    throw new Error(`build-ui: a template tag "<?" would remain in the output (line ${line})`);
  }
  if (write) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, html);
  }
  return html;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--stdout")) {
    process.stdout.write(buildUi({ write: false }));
  } else {
    const html = buildUi({ write: true });
    console.log(`${OUT} (${Buffer.byteLength(html)} bytes)`);
  }
}
