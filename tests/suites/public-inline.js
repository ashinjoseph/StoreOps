// ============================================================
//  public-inline — what the no-login pages inline cannot escape the script
// ============================================================
//  Both public pages render their data into an inline <script> as
//  `var DATA = <?!= payload ?>;`. The unescaping scriptlet is required (the
//  escaping one turns the JSON into a string — see wiring), which means the
//  HTML parser sees the payload raw. Free text a cashier types — a lotto
//  note, a handover note — reaches the recon payload, and a note containing
//  "</script>" would end the script there and run whatever came next for
//  every owner who opens the link.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Public pages — inlined data stays data');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const EVIL = '</script><script>window.PWNED=1</script><!--';

// HtmlService that performs the one substitution these templates use.
function htmlService() {
  return {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createTemplateFromFile(name) {
      const tpl = { };
      tpl.evaluate = () => {
        const src = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
        const html = src.replace(/<\?!=\s*payload\s*\?>/, () => tpl.payload);
        const out = { html, setTitle: () => out, setXFrameOptionsMode: () => out,
                      addMetaTag: () => out };
        return out;
      };
      return tpl;
    },
  };
}

function render(fn, payload) {
  const W = H.load(['Util.gs', 'WebApp.gs'], {
    HtmlService: htmlService(),
    PublicReport: { build: () => payload, buildSales: () => payload },
  });
  return W[fn]({ parameter: {} }).html;
}

// The inline script as the HTML parser sees it: from <script> to the FIRST
// </script>, whatever the JS inside meant.
function inlineScript(html) {
  const start = html.indexOf('var DATA = ');
  const end = html.indexOf('</script>', start);
  return html.slice(start, end);
}

[['the 7-day report', 'publicReconPage_', 'Public'],
 ['the sales page', 'publicSalesPage_', 'PublicSales']].forEach(([label, fn]) => {
  t.section(label + ': a note with </script> in it');
  const payload = { days: 7, reserve: { days: [{ dateStr: '2026-10-08', note: EVIL }] },
                    note: 'Paid a winner <b>$900</b> & topped up' };
  const html = render(fn, payload);
  const script = inlineScript(html);
  t.ok('the attacker\'s tag never reaches the HTML', html.indexOf(EVIL) === -1);
  t.ok('the script is not cut short by it', /var DATA = .*;\s*\n/.test(script));
  const line = /var DATA = (.*);\s*\n/.exec(script);
  const data = line && new Function('return ' + line[1])();
  t.eq('and the note arrives exactly as typed', data && data.reserve.days[0].note, EVIL);
  t.eq('ordinary markup in text survives too', data && data.note, payload.note);
});

t.done();
