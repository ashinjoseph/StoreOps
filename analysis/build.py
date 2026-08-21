#!/usr/bin/env python3
"""Embed data/insights.json into dashboard.html.

Run after analyse.py. The dashboard carries its data inline so the published
page is a single self-contained file with no fetches.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'data', 'insights.json')
PAGE = os.path.join(HERE, 'dashboard.html')

with open(SRC) as fh:
    payload = json.dumps(json.load(fh), separators=(',', ':'))

html = open(PAGE).read()
html, n = re.subn(
    r'(<script id="payload" type="application/json">).*?(</script>)',
    lambda m: m.group(1) + payload.replace('\\', '\\\\') + m.group(2),
    html, count=1, flags=re.S)
if n != 1:
    raise SystemExit('payload block not found in dashboard.html')

open(PAGE, 'w').write(html)
print(f'embedded {len(payload):,} bytes into dashboard.html')
