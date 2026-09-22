// ============================================================
//  public-chart — the day chart on the no-login sales page
// ============================================================
//  This page is opened from a WhatsApp link, usually on a phone, by someone
//  who is not going to tap a bar to find out what it is worth: there are no
//  tooltips on a touch screen. So every bar carries its amount above it, and
//  the track lands on the newest day rather than on the far edge of a
//  sixty-day window.
// ============================================================
// The store is in Eastern time and the page is read there. Pin it: a date
// parsed as UTC lands on the previous day west of Greenwich, and a suite run
// in a UTC container could never see that.
process.env.TZ = 'America/Toronto';

const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('Public sales chart');

const js = H.clientScript('PublicSales.html');
const lifted = ['esc', 'money', 'compact', 'shortDay', 'chart']
  .map(n => H.fnSource(js, n)).join('\n\n');
const ctx = vm.createContext({ console: console });
vm.runInContext(lifted, ctx);
const chart = ctx.chart;
const compact = ctx.compact;

function days(n, total) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ dateStr: '2026-09-' + String(i).padStart(2, '0'),
               total: total === undefined ? 1000 + i * 10 : total,
               byCompany: { cstore: 800, vape: 200 } });
  }
  return out;
}
const amounts = html => (html.match(/class="amt">([^<]*)</g) || [])
  .map(m => m.replace(/.*">/, '').replace('<', ''));

t.section('Every bar is labelled — there is no hover on a phone');
let html = chart(days(7), ['cstore', 'vape']);
t.eq('seven bars', (html.match(/class="col"/g) || []).length, 7);
t.eq('seven labels', amounts(html).length, 7);
t.eq('the first is the first day\'s total', amounts(html)[0], '$1.0k');
t.ok('every label is an amount', amounts(html).every(a => /^-?\$/.test(a)));

t.section('A single-company window still labels its bars');
html = chart(days(3), ['cstore']);
t.eq('three labels', amounts(html).length, 3);
t.ok('and no legend to explain a single series', html.indexOf('class="legend"') === -1);

t.section('Two companies get a legend and a stacked bar');
html = chart(days(3), ['cstore', 'vape']);
t.ok('legend present', html.indexOf('class="legend"') !== -1);
t.eq('each bar is stacked in two', (html.match(/class="seg c\d"/g) || []).length, 6);
t.ok('the tooltip still names the split for anyone who can hover',
     /cstore \$800\.00 · vape \$200\.00/.test(html));

t.section('A day whose payouts outran the takings reads as a loss');
html = chart([{ dateStr: '2026-09-01', total: -300, byCompany: { cstore: -300 } }], ['cstore']);
t.eq('the label keeps its sign', amounts(html), ['-$300']);
t.ok('and the bar still has a height to hang the label on', /height:3px/.test(html));

t.section('An empty window says so instead of drawing nothing');
html = chart([], ['cstore']);
t.ok('the empty state is explicit', /No sales in this window/.test(html));
t.ok('and no chart track is emitted', html.indexOf('class="chart"') === -1);

t.section('Bar heights are proportional and never invisible');
html = chart([{ dateStr: '2026-09-01', total: 1000, byCompany: {} },
              { dateStr: '2026-09-02', total: 500,  byCompany: {} },
              { dateStr: '2026-09-03', total: 0,    byCompany: {} }], ['cstore']);
const heights = (html.match(/class="bar[^"]*" style="height:(\d+)px/g) || [])
  .map(m => Number(/height:(\d+)px/.exec(m)[1]));
t.eq('the tallest fills the track', heights[0], 96);
t.eq('half the money is half the bar', heights[1], 48);
t.ok('a zero day is still a visible tick, not a gap', heights[2] >= 3);

t.section('A day is labelled by its weekday and date, read as a local date');
// Parsed field by field rather than handed to Date(): "2026-09-01" parsed as
// UTC lands on the previous day for anyone west of Greenwich.
html = chart([{ dateStr: '2026-09-01', total: 100, byCompany: {} }], ['cstore']);
t.ok('the weekday is the local one', /Tue/.test(html));
t.ok('and the day of the month is the one in the string', /<br>1</.test(html));

t.section('compact() — the label format');
t.eq('under a thousand is whole dollars', compact(950), '$950');
t.eq('thousands carry one decimal', compact(1361), '$1.4k');
t.eq('five figures drop it', compact(13610), '$14k');
t.eq('a negative keeps its sign', compact(-1361), '-$1.4k');
t.eq('a rounding-error zero does not get one', compact(-0.001), '$0');
t.eq('junk is zero, not NaN', compact('nonsense'), '$0');

t.section('The page lands on the newest day, not the far edge of the window');
// Sixty days of bars on a phone is several screens of scroll. Built
// oldest-first, so without this the reader opens on July.
const src = H.read('PublicSales.html');
t.ok('the track is scrolled after render',
     /querySelector\('\.chart'\)[\s\S]{0,200}scrollLeft/.test(src));
t.ok('to the end of the track', /scrollWidth\s*-\s*track\.clientWidth/.test(src));
t.ok('clamped so a short window does not scroll backwards',
     /Math\.max\(0,\s*track\.scrollWidth/.test(src));
// Prove it rather than matching on the source alone.
const scrollMatch = /var track = document\.querySelector[\s\S]*?clientWidth\);/.exec(src);
t.ok('the scroll step is still there to run', !!scrollMatch);
const scroll = scrollMatch ? scrollMatch[0] : 'void 0;';
function scrolledTo(track) {
  const c = vm.createContext({ document: { querySelector: () => track } });
  vm.runInContext(scroll, c);
  return track ? track.scrollLeft : null;
}
t.eq('a long window opens at the right-hand end',
     scrolledTo({ scrollLeft: 0, scrollWidth: 2400, clientWidth: 360 }), 2040);
t.eq('a window that fits stays put',
     scrolledTo({ scrollLeft: 0, scrollWidth: 300, clientWidth: 360 }), 0);
t.eq('and a missing track is not an error', scrolledTo(null), null);

t.done();
