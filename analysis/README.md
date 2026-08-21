# POS analysis — moved

The RetailPOS_DB sales analysis now lives in its own private repository:

**https://github.com/ashinjoseph/scarbro-pos-insights**

It was moved out so the analysis pipeline (SQL Server restore, Python
statistics, the dashboard) doesn't sit alongside this Apps Script project and
drift into two diverging copies. Nothing here depends on it, and it depends on
nothing here — the two only share a subject, Scarbro Mart.

Open `index.html` in that repo for the dashboard.

Headline findings, as of the 19 Aug 2026 backup:

- Total sales are flat (+1.1%, p = 0.91), hiding two significant opposing
  movements — visits +14.6% (p = 0.015) against basket −11.5% (p = 0.045).
- Only 15.7% of lottery customers buy anything else; 7,491 visits bought a
  ticket and nothing more.
- Three mis-keyed cash-tendered rows were repaired; reported cash fell from
  $886.9 billion to $170,730.74. `GrandTotal` was never affected.
