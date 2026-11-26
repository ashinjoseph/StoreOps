// inlineJson: the port of src/WebApp.gs inlineJson_, exactly.
//
// The public pages put their payload inside an inline <script> as `var DATA = <json>;`. The HTML
// parser ends a script at the first "</script" it sees, inside a JavaScript string or not, and
// treats "<!--" inside one as the start of an escaped section; notes cashiers type reach these
// payloads. So every "<" is written as <: the same string once JavaScript has parsed it,
// invisible to the HTML parser. With no "<" in it, neither "</script" (in any case) nor "<!--"
// nor "<script" can appear, so the JSON cannot end the script or change how it is parsed.
//
// What the old function did NOT escape, and why that stays as it is:
//   - U+2028 / U+2029: JSON.stringify leaves them raw. Since ES2019 they are legal inside a string
//     literal (JSON is a subset of JavaScript), and they mean nothing to the HTML parser, so they
//     cannot end the script in a modern browser. Not escaped, as before (a test parses them back).
//   - ">", "&", "]]>": nothing in an HTML script element reacts to them once "<" is gone
//     ("-->" only matters after a "<!--", which cannot occur; "]]>" only in XML/CDATA).
export function inlineJson(payload: unknown): string {
  return (JSON.stringify(payload) as string).replace(/</g, "\\u003c");
}
