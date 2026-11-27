// build-ui.mjs — make the Worker's copy of the page from src/Index.html, and the two
// public templates from src/Public.html and src/PublicSales.html.
//
//   node ops/tools/build-ui.mjs            writes ops/public/index.html and
//                                          ops/src/public/templates.generated.ts
//   node ops/tools/build-ui.mjs --stdout   prints the page instead
//
// Both outputs are built, not committed (.gitignore). `npm --prefix ops run build:ui` makes
// them; typecheck, test and parity run it first (package.json pre-scripts), and wrangler's
// [build] command runs it before dev and deploy.
//
// Built-ins only: the root test suites import this with no node_modules.
//
// Changes from the source, and nothing else:
//   1. /transport.js is loaded before the page's own script;
//   2. the shopping, suppliers and products entries leave MORE_ITEMS
//      (those screens are not being moved);
//   3. the two reads of those screens leave the warm-up list the page runs
//      after sign-in (they would answer 404 NOT_MIGRATED on every load);
//   4. Apps Script template tags are resolved. src/Index.html has none today
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
/** Reads the page warms after sign-in that belong to those screens. */
export const REMOVED_WARMUPS = ["rpcGetShoppingList", "rpcGetSuppliers"];
const TRANSPORT_TAG = '<script src="/transport.js"></script>';

// ── The public pages (?v=recon, ?v=sales) ──────────────────
//
// Not static assets: a file under public/ would be served raw, with the template tag in it and
// no payload. They become a module the Worker imports, each template split at its one payload
// tag into { before, after }; the Worker puts the inlined JSON between the two.
const PUBLIC_SOURCES = {
  recon: { file: "src/Public.html", path: resolve(HERE, "../../src/Public.html") },
  sales: { file: "src/PublicSales.html", path: resolve(HERE, "../../src/PublicSales.html") },
};
const TEMPLATES_OUT = resolve(HERE, "../src/public/templates.generated.ts");
/** The one scriptlet a public template may hold: Apps Script's force-print form. */
export const PAYLOAD_TAG = "<?!= payload ?>";

const countOf = (text, needle) => text.split(needle).length - 1;

/**
 * Split one public template at its payload tag. Refuses (throws) unless the template holds
 * exactly one "<?!= payload ?>" and no other "<?" or "?>" anywhere (the Apps Script rule: the
 * template engine opens a scriptlet on "<?" even inside a comment or a JS string), exactly one
 * <script> element, inline (no src: the page's policy allows that one script and nothing else),
 * and the tag inside that script as `var DATA = <?!= payload ?>;`.
 */
/** A checkout on Windows has CRLF line ends (Git's default there): build from the same text everywhere. */
const lf = (text) => text.replace(/\r\n?/g, "\n");

export function splitPublicTemplate(name, source) {
  const opens = countOf(source, "<?");
  const closes = countOf(source, "?>");
  const tags = countOf(source, PAYLOAD_TAG);
  if (tags !== 1 || opens !== 1 || closes !== 1) {
    throw new Error(`build-ui: ${name} must hold exactly one ${PAYLOAD_TAG} and no other "<?" or "?>" (found ${tags} payload tag(s), ${opens} "<?", ${closes} "?>")`);
  }
  const at = source.indexOf(PAYLOAD_TAG);
  const before = source.slice(0, at);
  const after = source.slice(at + PAYLOAD_TAG.length);
  const opening = source.match(/<script\b[^>]*>/gi) || [];
  const closing = source.match(/<\/script\s*>/gi) || [];
  if (opening.length !== 1 || closing.length !== 1) {
    throw new Error(`build-ui: ${name} must have exactly one <script> element (found ${opening.length} opening and ${closing.length} closing tags)`);
  }
  if (/\bsrc\s*=/i.test(opening[0])) throw new Error(`build-ui: ${name}'s script must be inline (no src)`);
  if (before.search(/<script\b[^>]*>/i) === -1 || after.search(/<\/script\s*>/i) === -1) {
    throw new Error(`build-ui: ${name}'s payload tag must be inside its <script>`);
  }
  if (!/var DATA = $/.test(before) || !after.startsWith(";")) {
    throw new Error(`build-ui: ${name} must inline the payload as \`var DATA = ${PAYLOAD_TAG};\``);
  }
  return { before, after };
}

/**
 * Build both public templates. `write` (default false) also writes
 * ops/src/public/templates.generated.ts. `sources` ({ recon, sales }) replaces the files' contents, for tests.
 */
export function buildPublicTemplates({ write = false, sources = {} } = {}) {
  const out = {};
  for (const [view, src] of Object.entries(PUBLIC_SOURCES)) {
    const text = lf(sources[view] ?? readFileSync(src.path, "utf8"));
    out[view] = { source: src.file, ...splitPublicTemplate(src.file, text) };
  }
  const module =
    "// GENERATED by ops/tools/build-ui.mjs from src/Public.html and src/PublicSales.html. Do not edit:\n" +
    "// change the source and run `npm --prefix ops run build:ui` (typecheck, test and parity run it first).\n" +
    "export interface PublicTemplate {\n  readonly source: string;\n  readonly before: string;\n  readonly after: string;\n}\n\n" +
    "export const PUBLIC_TEMPLATES: { readonly recon: PublicTemplate; readonly sales: PublicTemplate } = " +
    JSON.stringify(out, null, 2) +
    ";\n";
  if (write) {
    mkdirSync(dirname(TEMPLATES_OUT), { recursive: true });
    writeFileSync(TEMPLATES_OUT, module);
  }
  return { ...out, module };
}

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

/** Drop each removed read's line from the warm-up list: `['rpcName', [state.token], TTL_X],`. */
function removeWarmups(source) {
  const lines = source.split("\n");
  for (const name of REMOVED_WARMUPS) {
    const hits = [];
    lines.forEach((l, i) => {
      if (new RegExp(`^\\s*\\['${name}',\\s*\\[state\\.token[^\\]]*\\],\\s*TTL_[A-Z]+\\],\\s*(//.*)?$`).test(l)) hits.push(i);
    });
    if (hits.length !== 1) throw new Error(`build-ui: expected exactly one warm-up line for ${name}, found ${hits.length}`);
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
  const input = lf(source ?? readFileSync(SRC, "utf8"));
  const html = addTransport(removeWarmups(removeMoreItems(input)));
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
    const templates = buildPublicTemplates({ write: true });
    console.log(`${TEMPLATES_OUT} (${Buffer.byteLength(templates.module)} bytes)`);
  }
}
