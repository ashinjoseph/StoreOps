#!/usr/bin/env python3
"""Bundle data/*.psv into data/dash.json and embed it in the dashboard."""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
TEXT = {'cat', 'name', 'mode', 'bucket', 'date'}

SPECS = {
    'daily':    ('daily.psv',        ['date', 'inv', 'retail', 'lot_sale', 'lot_pay']),
    'hourdow':  ('hour_dow.psv',     ['dow', 'hour', 'inv', 'retail']),
    'category': ('category.psv',     ['cat', 'lines', 'rev', 'qty']),
    'top':      ('top_products.psv', ['name', 'cat', 'qty', 'rev', 'inv']),
    'payment':  ('payment.psv',      ['mode', 'n', 'amt']),
    'basket':   ('basket.psv',       ['bucket', 'n', 'amt']),
}

def load(fname, cols):
    rows = []
    with open(os.path.join(DATA, fname)) as fh:
        for line in fh:
            parts = [p.strip() for p in line.rstrip('\n').split('|')]
            if len(parts) != len(cols):
                continue
            row = {}
            for col, val in zip(cols, parts):
                if col not in TEXT:
                    try:
                        val = float(val)
                    except ValueError:
                        pass
                row[col] = val
            rows.append(row)
    return rows

data = {key: load(f, cols) for key, (f, cols) in SPECS.items()}
with open(os.path.join(DATA, 'dash.json'), 'w') as fh:
    json.dump(data, fh)

page = os.path.join(HERE, 'scarbro-pos-review.html')
html = open(page).read()
payload = json.dumps(data, separators=(',', ':'))
html, n = re.subn(
    r'(<script id="payload" type="application/json">).*?(</script>)',
    lambda m: m.group(1) + payload.replace('\\', '\\\\') + m.group(2),
    html, count=1, flags=re.S)
if n != 1:
    raise SystemExit('payload block not found in scarbro-pos-review.html')
open(page, 'w').write(html)
print('embedded %d bytes into %s' % (len(payload), os.path.basename(page)))
