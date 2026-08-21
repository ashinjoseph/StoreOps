#!/usr/bin/env python3
"""Turn the raw extracts in data/ into the analysed figures the dashboard shows.

Writes data/insights.json. Run after extract2.sh.

Conventions used throughout:
  * "Sales" = retail + lottery net of payouts, matching how the store books it.
  * Lottery is reported inside sales AND broken out separately.
  * Trend work uses whole Sun–Sat weeks only. The extract starts mid-week
    (Wed 15 Apr) and ends mid-week (Wed 19 Aug); including those stubs would
    read as a fake collapse at both ends.
"""
import json
import os
from datetime import date, timedelta

import numpy as np
import pandas as pd
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')

DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
LOTTERY_COMMISSION_RATE = 0.05   # indicative OLG retailer rate; confirm on statements


def psv(name, cols):
    df = pd.read_csv(os.path.join(DATA, name), sep='|', header=None,
                     names=cols, engine='python')
    return df.dropna(how='all')


def trend(y, x=None):
    """OLS fit. Returns slope, per-period change, R^2, p, and a 95% CI."""
    y = np.asarray(y, dtype=float)
    x = np.arange(len(y), dtype=float) if x is None else np.asarray(x, dtype=float)
    r = stats.linregress(x, y)
    n = len(y)
    tcrit = stats.t.ppf(0.975, n - 2) if n > 2 else float('nan')
    return {
        'slope': float(r.slope),
        'intercept': float(r.intercept),
        'r2': float(r.rvalue ** 2),
        'p': float(r.pvalue),
        'stderr': float(r.stderr),
        'ci_lo': float(r.slope - tcrit * r.stderr),
        'ci_hi': float(r.slope + tcrit * r.stderr),
        'n': int(n),
        'total_change': float(r.slope * (n - 1)),
        'pct_change': float(r.slope * (n - 1) / r.intercept * 100) if r.intercept else None,
        'significant': bool(r.pvalue < 0.05),
    }


# ---------------------------------------------------------------- daily base
daily = psv('daily.psv', ['date', 'txns', 'retail', 'lot_gross', 'lot_pay',
                          'retail_txns', 'lot_txns'])
daily['date'] = pd.to_datetime(daily['date'])
daily['lot_pay'] = daily['lot_pay'].abs()
daily['lot_net'] = daily['lot_gross'] - daily['lot_pay']
daily['sales'] = daily['retail'] + daily['lot_net']
daily['dow'] = daily['date'].dt.dayofweek           # Mon=0
daily['week'] = daily['date'] - pd.to_timedelta((daily['date'].dt.dayofweek + 1) % 7, unit='D')

first, last = daily['date'].min(), daily['date'].max()

# Whole Sun–Sat weeks only.
wk = daily.groupby('week').agg(
    days=('date', 'count'), sales=('sales', 'sum'), retail=('retail', 'sum'),
    lot_gross=('lot_gross', 'sum'), lot_pay=('lot_pay', 'sum'),
    lot_net=('lot_net', 'sum'), txns=('txns', 'sum'),
    retail_txns=('retail_txns', 'sum')).reset_index()
full = wk[wk['days'] == 7].copy().reset_index(drop=True)
full['basket'] = full['retail'] / full['retail_txns']

t_sales = trend(full['sales'])
t_retail = trend(full['retail'])
t_txns = trend(full['txns'])
t_basket = trend(full['basket'])
t_lottery = trend(full['lot_net'])

# ------------------------------------------------------- category over time
cw = psv('cat_week.psv', ['cat', 'week', 'rev'])
cw['week'] = pd.to_datetime(cw['week'])
full_weeks = set(full['week'])
cwf = cw[cw['week'].isin(full_weeks)]

cat_tot = psv('category.psv', ['cat', 'lines', 'rev', 'qty', 'invs'])
retail_cats = cat_tot[cat_tot['cat'] != 'LOTTERY'].sort_values('rev', ascending=False)
TOP_N = 8
top_cats = list(retail_cats.head(TOP_N)['cat'])

pivot = cwf.pivot_table(index='week', columns='cat', values='rev',
                        aggfunc='sum', fill_value=0.0).sort_index()
for c in top_cats + ['LOTTERY']:
    if c not in pivot.columns:
        pivot[c] = 0.0

cat_series = []
for c in top_cats + ['LOTTERY']:
    s = pivot[c].astype(float)
    tr = trend(s.values)
    n = len(s)
    half = max(1, n // 2)
    h1, h2 = s.iloc[:half].mean(), s.iloc[-half:].mean()
    cat_series.append({
        'cat': c,
        'weekly': [round(v, 2) for v in s.values],
        'total': float(s.sum()),
        'slope': tr['slope'],
        'pct_change': tr['pct_change'],
        'p': tr['p'],
        'significant': tr['significant'],
        'h1_avg': float(h1),
        'h2_avg': float(h2),
        'half_change_pct': float((h2 - h1) / h1 * 100) if h1 else None,
    })

# Share-of-mix drift, first half vs second half of the whole-week window.
mid = full['week'].iloc[len(full) // 2]
retail_only = cwf[cwf['cat'] != 'LOTTERY']
mix1 = retail_only[retail_only['week'] < mid].groupby('cat')['rev'].sum()
mix2 = retail_only[retail_only['week'] >= mid].groupby('cat')['rev'].sum()
mix = pd.DataFrame({'h1': mix1, 'h2': mix2}).fillna(0.0)
mix['h1_share'] = mix['h1'] / mix['h1'].sum() * 100
mix['h2_share'] = mix['h2'] / mix['h2'].sum() * 100
mix['drift'] = mix['h2_share'] - mix['h1_share']
mix = mix.sort_values('h2', ascending=False).head(10)

# ------------------------------------------------------------------ lottery
lot = psv('lottery_daily.psv', ['date', 'gross', 'payout', 'txns'])
lot['date'] = pd.to_datetime(lot['date'])
lot_gross, lot_payout = float(lot['gross'].sum()), float(lot['payout'].sum())
lot_net = lot_gross - lot_payout

lp = psv('lottery_products.psv', ['name', 'lines', 'rev'])
lp_sales = lp[lp['rev'] > 0].copy()
lp_pay = lp[lp['rev'] < 0].copy()

attach = psv('attach.psv', ['kind', 'invs', 'retail_val'])
a = {r['kind']: r for _, r in attach.iterrows()}
lot_only = int(a.get('lottery only', {}).get('invs', 0))
both = int(a.get('both', {}).get('invs', 0))
retail_only = int(a.get('retail only', {}).get('invs', 0))
attach_rate = both / (lot_only + both) * 100 if (lot_only + both) else 0.0
basket_with = float(a.get('both', {}).get('retail_val', 0)) / both if both else 0.0
basket_without = float(a.get('retail only', {}).get('retail_val', 0)) / retail_only if retail_only else 0.0

# --------------------------------------------------------------- weekday
dow = psv('dow.psv', ['dow', 'days', 'txns', 'retail', 'lottery'])
dow['name'] = dow['dow'].apply(lambda d: DOW_NAMES[int(d) - 1])
dow['sales_per_day'] = (dow['retail'] + dow['lottery']) / dow['days']
dow['retail_per_day'] = dow['retail'] / dow['days']
dow['txns_per_day'] = dow['txns'] / dow['days']

# --------------------------------------------------------------- movers
mv = psv('movers.psv', ['name', 'cat', 'h1', 'h2'])
mv['delta'] = mv['h2'] - mv['h1']
mv['pct'] = np.where(mv['h1'] > 0, (mv['h2'] - mv['h1']) / mv['h1'] * 100, np.nan)
risers = mv.sort_values('delta', ascending=False).head(12)
fallers = mv.sort_values('delta').head(12)

# --------------------------------------------------------------- payments
pay = psv('payment.psv', ['mode', 'n', 'amt'])
paym = psv('payment_month.psv', ['mode', 'month', 'n', 'amt'])
pm = paym.pivot_table(index='month', columns='mode', values='n',
                      aggfunc='sum', fill_value=0).sort_index()
pm_share = pm.div(pm.sum(axis=1), axis=0) * 100

basket_b = psv('basket.psv', ['bucket', 'n', 'amt'])
hour_dow = psv('hour_dow.psv', ['dow', 'hour', 'txns', 'retail', 'lottery'])

# --------------------------------------------------------------- assemble
out = {
    'meta': {
        'first': first.strftime('%Y-%m-%d'),
        'last': last.strftime('%Y-%m-%d'),
        'days': int(len(daily)),
        'full_weeks': int(len(full)),
        'week_from': full['week'].min().strftime('%Y-%m-%d'),
        'week_to': (full['week'].max() + timedelta(days=6)).strftime('%Y-%m-%d'),
        'commission_rate': LOTTERY_COMMISSION_RATE,
    },
    'totals': {
        'sales': float(daily['sales'].sum()),
        'retail': float(daily['retail'].sum()),
        'lot_gross': lot_gross,
        'lot_payout': lot_payout,
        'lot_net': lot_net,
        'lot_commission_est': lot_gross * LOTTERY_COMMISSION_RATE,
        'txns': int(daily['txns'].sum()),
        'retail_txns': int(daily['retail_txns'].sum()),
        'avg_basket': float(daily['retail'].sum() / daily['retail_txns'].sum()),
        'avg_daily_sales': float(daily['sales'].mean()),
    },
    'trend': {
        'sales': t_sales, 'retail': t_retail, 'txns': t_txns,
        'basket': t_basket, 'lottery': t_lottery,
    },
    'weekly': [
        {'week': r['week'].strftime('%Y-%m-%d'), 'sales': round(r['sales'], 2),
         'retail': round(r['retail'], 2), 'lot_net': round(r['lot_net'], 2),
         'txns': int(r['txns']), 'basket': round(r['basket'], 2)}
        for _, r in full.iterrows()
    ],
    'daily': [
        {'date': r['date'].strftime('%Y-%m-%d'), 'sales': round(r['sales'], 2),
         'retail': round(r['retail'], 2), 'lot_gross': round(r['lot_gross'], 2),
         'lot_pay': round(r['lot_pay'], 2), 'txns': int(r['txns'])}
        for _, r in daily.iterrows()
    ],
    'cat_weeks': [w.strftime('%Y-%m-%d') for w in pivot.index],
    'cat_series': cat_series,
    'cat_totals': [
        {'cat': r['cat'], 'rev': float(r['rev']), 'qty': float(r['qty']),
         'lines': int(r['lines']), 'invs': int(r['invs'])}
        for _, r in cat_tot.iterrows()
    ],
    'mix_drift': [
        {'cat': i, 'h1_share': round(r['h1_share'], 2), 'h2_share': round(r['h2_share'], 2),
         'drift': round(r['drift'], 2)}
        for i, r in mix.iterrows()
    ],
    'lottery': {
        'gross': lot_gross, 'payout': lot_payout, 'net': lot_net,
        'payout_ratio': lot_payout / lot_gross * 100 if lot_gross else 0,
        'commission_est': lot_gross * LOTTERY_COMMISSION_RATE,
        'share_of_sales': lot_net / float(daily['sales'].sum()) * 100,
        'lottery_only_txns': lot_only, 'both_txns': both, 'retail_only_txns': retail_only,
        'attach_rate': attach_rate,
        'basket_with_lottery': basket_with,
        'basket_without_lottery': basket_without,
        'daily': [{'date': r['date'].strftime('%Y-%m-%d'), 'gross': round(r['gross'], 2),
                   'payout': round(r['payout'], 2)} for _, r in lot.iterrows()],
        'products': [{'name': r['name'], 'rev': float(r['rev'])}
                     for _, r in lp_sales.head(12).iterrows()],
        'payouts': [{'name': r['name'], 'rev': float(r['rev'])} for _, r in lp_pay.iterrows()],
    },
    'dow': [
        {'name': r['name'], 'sales_per_day': round(r['sales_per_day'], 2),
         'retail_per_day': round(r['retail_per_day'], 2),
         'txns_per_day': round(r['txns_per_day'], 1)}
        for _, r in dow.iterrows()
    ],
    'hour_dow': [
        {'dow': int(r['dow']), 'hour': int(r['hour']), 'txns': int(r['txns']),
         'retail': float(r['retail']), 'lottery': float(r['lottery'])}
        for _, r in hour_dow.iterrows()
    ],
    'risers': [{'name': r['name'], 'cat': r['cat'], 'h1': float(r['h1']),
                'h2': float(r['h2']), 'delta': float(r['delta'])}
               for _, r in risers.iterrows()],
    'fallers': [{'name': r['name'], 'cat': r['cat'], 'h1': float(r['h1']),
                 'h2': float(r['h2']), 'delta': float(r['delta'])}
                for _, r in fallers.iterrows()],
    'payment': [{'mode': r['mode'], 'n': int(r['n']), 'amt': float(r['amt'])}
                for _, r in pay.iterrows()],
    'payment_share': {'months': list(pm_share.index),
                      'modes': {c: [round(v, 2) for v in pm_share[c]] for c in pm_share.columns}},
    'basket_buckets': [{'bucket': r['bucket'], 'n': int(r['n']), 'amt': float(r['amt'])}
                       for _, r in basket_b.iterrows()],
    'top_products': [
        {'name': r['name'], 'cat': r['cat'], 'qty': float(r['qty']), 'rev': float(r['rev'])}
        for _, r in psv('top_products.psv',
                        ['name', 'cat', 'qty', 'rev', 'invs']).head(40).iterrows()
    ],
}

with open(os.path.join(DATA, 'insights.json'), 'w') as fh:
    json.dump(out, fh)

# ------------------------------------------------------------------ console
def pct(v):
    return '—' if v is None or (isinstance(v, float) and np.isnan(v)) else f'{v:+.1f}%'

print(f"Period {out['meta']['first']} → {out['meta']['last']} "
      f"({out['meta']['days']} days, {out['meta']['full_weeks']} whole weeks)")
print(f"Sales {out['totals']['sales']:,.2f} "
      f"(retail {out['totals']['retail']:,.2f} + lottery net {lot_net:,.2f})")
print()
print('TREND over whole weeks (slope per week):')
for k, t in out['trend'].items():
    flag = 'SIGNIFICANT' if t['significant'] else 'not significant'
    print(f"  {k:8s} {t['slope']:+10.2f}/wk  R²={t['r2']:.3f}  p={t['p']:.4f}  "
          f"{pct(t['pct_change'])} over window  [{flag}]")
print()
print('CATEGORY momentum (first half vs second half of window):')
for c in sorted(cat_series, key=lambda d: -d['total']):
    print(f"  {c['cat'][:26]:26s} {c['total']:9,.0f}  {pct(c['half_change_pct']):>8s}  "
          f"p={c['p']:.3f}{'  *' if c['significant'] else ''}")
print()
print(f"LOTTERY gross {lot_gross:,.0f}  payout {lot_payout:,.0f} "
      f"({out['lottery']['payout_ratio']:.1f}%)  net {lot_net:,.0f}")
print(f"  attach rate {attach_rate:.1f}%  "
      f"({both:,} of {lot_only + both:,} lottery baskets also bought goods)")
print(f"  basket when lottery present ${basket_with:.2f} vs ${basket_without:.2f} without")
print()
print('Wrote data/insights.json')
