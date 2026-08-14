// ============================================================
//  ProductMaster.gs — thin CORE catalog of products
// ============================================================
//  The core row holds identity + the RESOLVED per-unit numbers that
//  every consumer reads (cost_price, sell_price, sell_price_credit,
//  margin_amount, margin_pct). Those resolved numbers are DERIVED in
//  code from per-type inputs that live in a separate detail sheet —
//  one per type, keyed 1:1 by product_id. See ProductTypes.gs for the
//  registry (detail columns, derivePricing, validate, field schema).
//
//    beer       → product_beer_detail        (LCBO case price, deposit, …)
//    cigarettes → product_cigarettes_detail  (cost/carton, packs/carton, …)
//    vape       → product_vape_detail         (puffs, mL, nicotine, flavor, …)
//    grocery / other → CORE only (plain cost/sell/margin, no detail row)
//
//  Lists + search read the CORE only (never join) so they stay fast;
//  the detail is hydrated only on single-record gets (getWithDetail).
//
//  margin_amount + margin_pct are recomputed on every write — never
//  trust the stored values across writes; they exist so spreadsheet
//  users can sort. min_sell_price = discount floor; the UI flags any
//  product whose sell_price falls below it.
// ============================================================

const ProductMaster = (() => {

  const COL = {
    product_id: 1, sku: 2, barcode: 3, product_name: 4, brand: 5,
    category: 6, subcategory: 7, pack_size: 8, unit: 9, supplier: 10,
    cost_price: 11, sell_price: 12, sell_price_credit: 13, min_sell_price: 14,
    margin_amount: 15, margin_pct: 16,
    active: 17, notes: 18, source_file: 19,
    created_by: 20, created_at: 21, updated_by: 22, updated_at: 23,
  };
  const NUM_COLS = 23;
  const DATA_START_ROW = 3;

  // ── Cache strategy ────────────────────────────────────────
  // GAS CacheService caps each entry at ~100 KB. Caching the full record
  // list as one blob blows up around ~600-800 products (~250 bytes/row).
  // We chunk into N entries of CHUNK_SIZE records (~50 KB at 200 rows) plus
  // a manifest key holding the chunk count. One round-trip for reads
  // (getAll), one for writes (putAll), one for busts (removeAll). Caches
  // the CORE only — detail rows are read on demand, never cached.
  const CACHE_NS         = 'storeops:product_master:';
  const CACHE_MANIFEST   = CACHE_NS + 'manifest';
  const CACHE_LEGACY_KEY = 'storeops:product_master';   // pre-chunking single-blob key (cleanup)
  const CACHE_CHUNK_SIZE = 200;                          // records per chunk
  const CACHE_TTL        = 600;                          // 10 min
  const MAX_CHUNKS_BUST  = 50;                           // safety cap when manifest is corrupt

  const VALID_CATEGORIES = ['vape', 'cigarettes', 'beer', 'grocery', 'other'];

  function chunkKey_(i) { return CACHE_NS + 'chunk:' + i; }

  function bustCache_() {
    try {
      const cache = CacheService.getScriptCache();
      const manifest = cache.get(CACHE_MANIFEST);
      let n = 0;
      if (manifest) {
        const parsed = parseInt(manifest, 10);
        if (!isNaN(parsed) && parsed >= 0) n = Math.min(parsed, MAX_CHUNKS_BUST);
      }
      const keys = [CACHE_MANIFEST, CACHE_LEGACY_KEY];
      for (let i = 0; i < n; i++) keys.push(chunkKey_(i));
      cache.removeAll(keys);
    } catch (e) { /* best-effort */ }
  }

  function readCache_() {
    try {
      const cache = CacheService.getScriptCache();
      const manifest = cache.get(CACHE_MANIFEST);
      if (!manifest) return null;
      const n = parseInt(manifest, 10);
      if (isNaN(n) || n < 0 || n > MAX_CHUNKS_BUST) return null;
      if (n === 0) return [];
      const keys = [];
      for (let i = 0; i < n; i++) keys.push(chunkKey_(i));
      const chunks = cache.getAll(keys);
      let records = [];
      for (let i = 0; i < n; i++) {
        const blob = chunks[chunkKey_(i)];
        if (!blob) return null;     // partial expiry — treat as cold
        records = records.concat(JSON.parse(blob));
      }
      return records.map(reviveRecord_);
    } catch (e) {
      return null;
    }
  }

  function writeCache_(records) {
    try {
      const cache = CacheService.getScriptCache();
      const toPut = {};
      let n = 0;
      for (let i = 0; i < records.length; i += CACHE_CHUNK_SIZE) {
        toPut[chunkKey_(n)] = JSON.stringify(records.slice(i, i + CACHE_CHUNK_SIZE));
        n++;
      }
      toPut[CACHE_MANIFEST] = String(n);
      cache.putAll(toPut, CACHE_TTL);
    } catch (e) {
      bustCache_();
    }
  }

  function reviveRecord_(r) {
    if (r.createdAt && !(r.createdAt instanceof Date)) r.createdAt = new Date(r.createdAt);
    if (r.updatedAt && !(r.updatedAt instanceof Date)) r.updatedAt = new Date(r.updatedAt);
    return r;
  }

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PRODUCT_MASTER);
    if (!sh) throw new Error('product_master sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    return {
      productId:       (row[COL.product_id - 1] || '').toString().trim(),
      sku:             (row[COL.sku - 1] || '').toString().trim(),
      barcode:         (row[COL.barcode - 1] || '').toString().trim(),
      productName:     (row[COL.product_name - 1] || '').toString().trim(),
      brand:           (row[COL.brand - 1] || '').toString().trim(),
      category:        (row[COL.category - 1] || '').toString().trim().toLowerCase(),
      subcategory:     (row[COL.subcategory - 1] || '').toString().trim(),
      packSize:        (row[COL.pack_size - 1] || '').toString().trim(),
      unit:            (row[COL.unit - 1] || '').toString().trim(),
      supplier:        (row[COL.supplier - 1] || '').toString().trim(),
      costPrice:       Number(row[COL.cost_price - 1]) || 0,
      sellPrice:       Number(row[COL.sell_price - 1]) || 0,
      sellPriceCredit: Number(row[COL.sell_price_credit - 1]) || 0,
      minSellPrice:    Number(row[COL.min_sell_price - 1]) || 0,
      marginAmount:    Number(row[COL.margin_amount - 1]) || 0,
      marginPct:       Number(row[COL.margin_pct - 1]) || 0,
      active:          row[COL.active - 1] === true,
      notes:           (row[COL.notes - 1] || '').toString(),
      sourceFile:      (row[COL.source_file - 1] || '').toString().trim(),
      createdBy:       (row[COL.created_by - 1] || '').toString().trim(),
      createdAt:       row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : null,
      updatedBy:       (row[COL.updated_by - 1] || '').toString().trim(),
      updatedAt:       row[COL.updated_at - 1] instanceof Date ? row[COL.updated_at - 1] : null,
      _rowIndex:       rowIndex,
    };
  }

  // computeMargin_ — pure helper. marginPct returned as 0..1.
  function computeMargin_(costPrice, sellPrice) {
    const c = Util.roundMoney(Number(costPrice) || 0);
    const s = Util.roundMoney(Number(sellPrice) || 0);
    const amt = Util.roundMoney(s - c);
    const pct = s > 0 ? Math.round(((s - c) / s) * 10000) / 10000 : 0;
    return { marginAmount: amt, marginPct: pct };
  }

  function normalizeCategory_(s) {
    const c = (s || '').toString().trim().toLowerCase();
    const aliased = c === 'vapes' ? 'vape' : c;
    if (VALID_CATEGORIES.indexOf(aliased) === -1) {
      throw new Error('invalid category: "' + s + '" (expected one of: ' + VALID_CATEGORIES.join(', ') + ')');
    }
    return aliased;
  }

  // ── Detail sheets (per-type, 1:1 by product_id) ───────────
  function detailSheet_(category) {
    const name = ProductTypes.detailSheet(category);
    if (!name) return null;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (!sh) throw new Error(name + ' sheet not found — run setup / migration');
    return sh;
  }

  // Read the detail row for a product as a snake_case object, coercing
  // numeric columns. Returns {} when the type has no detail sheet or no row.
  function readDetail_(productId, category) {
    if (!productId || !ProductTypes.has(category)) return {};
    const sh = detailSheet_(category);
    const cols = ProductTypes.detailColumns(category);
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return {};
    const numeric = new Set(ProductTypes.numericColumns(category));
    const values = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, cols.length).getValues();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if ((row[0] || '').toString().trim() !== productId) continue;   // product_id is col 1
      const obj = {};
      cols.forEach((c, idx) => {
        const v = row[idx];
        if (numeric.has(c)) obj[c] = Number(v) || 0;
        else if (c === 'created_at' || c === 'updated_at') obj[c] = (v instanceof Date) ? v : null;
        else obj[c] = (v == null ? '' : v.toString());
      });
      return obj;
    }
    return {};
  }

  function buildDetailRow_(productId, sku, category, detail, createdAt) {
    const cols = ProductTypes.detailColumns(category);
    const numeric = new Set(ProductTypes.numericColumns(category));
    const now = new Date();
    return cols.map(c => {
      if (c === 'product_id') return productId;
      if (c === 'sku')        return (sku || '').toString().trim();
      if (c === 'created_at') return createdAt || now;
      if (c === 'updated_at') return now;
      const v = detail ? detail[c] : '';
      if (numeric.has(c)) return Number(v) || 0;
      return (v == null ? '' : v.toString());
    });
  }

  // Upsert the detail row keyed by product_id. Preserves created_at on update.
  function writeDetail_(productId, sku, category, detail) {
    if (!ProductTypes.has(category)) return;
    const sh = detailSheet_(category);
    const cols = ProductTypes.detailColumns(category);
    const last = sh.getLastRow();
    let foundRow = -1;
    let createdAt = null;
    if (last >= DATA_START_ROW) {
      const idCol = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, 1).getValues();
      for (let i = 0; i < idCol.length; i++) {
        if ((idCol[i][0] || '').toString().trim() === productId) { foundRow = DATA_START_ROW + i; break; }
      }
      if (foundRow > 0) {
        const caIdx = cols.indexOf('created_at');
        if (caIdx >= 0) {
          const ca = sh.getRange(foundRow, caIdx + 1).getValue();
          createdAt = ca instanceof Date ? ca : null;
        }
      }
    }
    const rowValues = buildDetailRow_(productId, sku, category, detail, createdAt);
    const targetRow = foundRow > 0 ? foundRow : (sh.getLastRow() + 1);
    sh.getRange(targetRow, 1, 1, cols.length).setValues([rowValues]);
  }

  // ── Reads ─────────────────────────────────────────────────
  function getAll_(includeInactive) {
    let records = readCache_();
    if (records === null) {
      const sh = sheet_();
      const last = sh.getLastRow();
      records = last < DATA_START_ROW ? [] :
        sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS)
          .getValues()
          .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
          .filter(r => r.productId);
      writeCache_(records);
    }
    return includeInactive ? records : records.filter(r => r.active);
  }

  function getById_(productId) {
    if (!productId) return null;
    return getAll_(true).find(r => r.productId === productId) || null;
  }

  // Core record + hydrated `.detail` (snake_case) for registry types,
  // else `.detail = null`. Use for single-record gets, NOT bulk loops.
  function getWithDetail_(productId) {
    const r = getById_(productId);
    if (!r) return null;
    r.detail = ProductTypes.has(r.category) ? readDetail_(productId, r.category) : null;
    return r;
  }

  function getBySku_(sku) {
    if (!sku) return null;
    const key = sku.toString().trim().toLowerCase();
    if (!key) return null;
    return getAll_(true).find(r => r.sku && r.sku.toLowerCase() === key) || null;
  }

  // Substring AND across whitespace terms, matching any of
  // sku/productName/brand/category/subcategory. Cap at 200 results.
  function search_(query, opts) {
    opts = opts || {};
    const includeInactive = opts.includeInactive === true;
    const categoryFilter = opts.category ? opts.category.toString().trim().toLowerCase() : null;
    const terms = (query || '').toString().toLowerCase().trim().split(/\s+/).filter(Boolean);

    let records = getAll_(includeInactive);
    if (categoryFilter) records = records.filter(r => r.category === categoryFilter);
    if (terms.length === 0) return records.slice(0, 200);

    const matched = records.filter(r => {
      const hay = [r.sku, r.productName, r.brand, r.category, r.subcategory].join(' ').toLowerCase();
      return terms.every(t => hay.indexOf(t) >= 0);
    });
    return matched.slice(0, 200);
  }

  // Dedup key on the CORE row. Beer keys on sku + unit (same SKU is
  // listed once per sell unit); everything else on sku, then brand+name.
  function findDuplicate_(input, includeInactive) {
    const all = getAll_(includeInactive !== false);
    const category = (input.category || '').toString().trim().toLowerCase();
    const sku = (input.sku || '').toString().trim().toLowerCase();
    const keyFields = ProductTypes.keyFields(category);
    if (sku && keyFields.indexOf('unit') >= 0) {
      const unit = (input.unit || '').toString().trim().toLowerCase();
      return all.find(r => r.sku && r.sku.toLowerCase() === sku && (r.unit || '').toLowerCase() === unit) || null;
    }
    if (sku) return all.find(r => r.sku && r.sku.toLowerCase() === sku) || null;
    const brand = (input.brand || '').toString().trim().toLowerCase();
    const name = (input.productName || '').toString().trim().toLowerCase();
    if (!name) return null;
    return all.find(r => r.brand.toLowerCase() === brand && r.productName.toLowerCase() === name) || null;
  }

  // Resolve cost/sell/credit/margin for a category from its detail inputs
  // (registry types) or directly from the core input (grocery / other).
  function resolvePricing_(category, input, detail) {
    if (ProductTypes.has(category)) {
      const errs = ProductTypes.validate(category, detail);
      if (errs.length) throw new Error('invalid ' + category + ' detail: ' + errs.join('; '));
      return ProductTypes.derivePricing(category, detail);
    }
    const cost = Util.roundMoney(Number(input.costPrice) || 0);
    const sell = Util.roundMoney(Number(input.sellPrice) || 0);
    const m = computeMargin_(cost, sell);
    return {
      costPrice: cost, sellPrice: sell,
      sellPriceCredit: Util.roundMoney(Number(input.sellPriceCredit) || 0),
      marginAmount: m.marginAmount, marginPct: m.marginPct,
    };
  }

  /**
   * Append a new product (core row + detail row for registry types).
   *
   * @param input {
   *   sku?, barcode?, productName (req), brand?, category (req),
   *   subcategory?, packSize?, unit?, supplier?, minSellPrice?, notes?,
   *   costPrice?, sellPrice?, sellPriceCredit?,   // grocery/other only
   *   detail?: { ...snake_case type inputs },     // registry types
   *   sourceFile?, actorId (req)
   * }
   * Dedup: beer by sku+unit, else sku, else brand+name. On a dedup match
   * (active OR inactive) returns the existing record and audits — no append.
   */
  function create_(input) {
    if (!input.productName || !input.productName.toString().trim()) {
      throw new Error('productName is required');
    }
    if (!input.actorId) throw new Error('actorId required');
    const category = normalizeCategory_(input.category);
    const detail = input.detail || {};

    // core.unit can mirror a detail field (beer → sell_unit)
    const unitFrom = ProductTypes.unitFrom(category);
    let unit = (input.unit || '').toString().trim();
    if (unitFrom && detail[unitFrom]) unit = detail[unitFrom].toString().trim();
    if (!unit) unit = 'each';

    bustCache_();   // ensure dedup read is fresh
    const existing = findDuplicate_(Object.assign({}, input, { category, unit }), true);
    if (existing) {
      AuditLog.write({
        actorId: input.actorId,
        action: existing.active ? 'product.dedup_hit' : 'product.dedup_hit_inactive',
        targetType: 'product',
        targetId: existing.productId,
        after: {
          dedupKey: input.sku ? (unitFrom ? 'sku+unit' : 'sku') : 'brand+name',
          attemptedName: input.productName,
          attemptedSku: input.sku || '',
        },
      });
      return existing;
    }

    const resolved = resolvePricing_(category, input, detail);
    const productId = Util.newId('PM');
    const sku = (input.sku || '').toString().trim();
    const minSellPrice = Util.roundMoney(Number(input.minSellPrice) || 0);
    const now = new Date();

    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      productId,
      sku,
      (input.barcode || '').toString().trim(),
      input.productName.toString().trim(),
      (input.brand || '').toString().trim(),
      category,
      (input.subcategory || '').toString().trim(),
      (input.packSize || '').toString().trim(),
      unit,
      (input.supplier || '').toString().trim(),
      resolved.costPrice,
      resolved.sellPrice,
      resolved.sellPriceCredit,
      minSellPrice,
      resolved.marginAmount,
      resolved.marginPct,
      true,
      (input.notes || '').toString(),
      (input.sourceFile || 'manual').toString().trim(),
      input.actorId,
      now,
      input.actorId,
      now,
    ]]);

    if (ProductTypes.has(category)) writeDetail_(productId, sku, category, detail);

    AuditLog.write({
      actorId: input.actorId,
      action: 'product.created',
      targetType: 'product',
      targetId: productId,
      after: {
        sku, productName: input.productName, brand: input.brand || '',
        category, unit,
        costPrice: resolved.costPrice, sellPrice: resolved.sellPrice,
        sellPriceCredit: resolved.sellPriceCredit, minSellPrice,
        marginAmount: resolved.marginAmount, marginPct: resolved.marginPct,
        detail: ProductTypes.has(category) ? detail : null,
        sourceFile: input.sourceFile || 'manual',
      },
    });

    bustCache_();
    return getById_(productId);
  }

  // Immutable fields silently dropped from a patch.
  const IMMUTABLE_FIELDS = new Set([
    'productId', 'sku', 'barcode', 'sourceFile', 'createdBy', 'createdAt',
    'updatedBy', 'updatedAt',
    'marginAmount', 'marginPct',   // always recomputed; can't be patched directly
  ]);

  // Editable CORE scalar fields → column. Detail inputs go through patch.detail.
  const PATCH_TO_COL = {
    productName:     COL.product_name,
    brand:           COL.brand,
    category:        COL.category,
    subcategory:     COL.subcategory,
    packSize:        COL.pack_size,
    unit:            COL.unit,
    supplier:        COL.supplier,
    costPrice:       COL.cost_price,        // grocery/other; overwritten by derive for registry types
    sellPrice:       COL.sell_price,        // grocery/other; overwritten by derive for registry types
    sellPriceCredit: COL.sell_price_credit,
    minSellPrice:    COL.min_sell_price,
    notes:           COL.notes,
    active:          COL.active,
  };

  const MONEY_FIELDS = new Set(['costPrice', 'sellPrice', 'sellPriceCredit', 'minSellPrice']);

  // Write resolved cost/sell/credit/margin onto the core row, recording
  // before/after for any value that actually changed.
  function applyResolved_(sh, r, existing, resolved, before, after) {
    const fields = [
      ['costPrice',       COL.cost_price],
      ['sellPrice',       COL.sell_price],
      ['sellPriceCredit', COL.sell_price_credit],
      ['marginAmount',    COL.margin_amount],
      ['marginPct',       COL.margin_pct],
    ];
    fields.forEach(([k, col]) => {
      const nv = resolved[k];
      if (existing[k] !== nv) {
        sh.getRange(r, col).setValue(nv);
        if (!(k in after)) { before[k] = existing[k]; after[k] = nv; }
      }
    });
  }

  /**
   * Partial update. CORE scalars come through PATCH_TO_COL; per-type
   * inputs come through patch.detail (snake_case). For registry types,
   * any detail change (or a category change) re-derives and overwrites
   * the resolved cost/sell/credit/margin. For grocery/other, margin is
   * recomputed when cost or sell changes. One audit row per update.
   */
  function update_(productId, patch, actorId) {
    if (!productId) throw new Error('productId required');
    if (!actorId) throw new Error('actorId required');
    patch = patch || {};

    bustCache_();
    const existing = getById_(productId);
    if (!existing) throw new Error('Product not found: ' + productId);

    const before = {};
    const after = {};
    const sh = sheet_();
    const r = existing._rowIndex;

    // 1. core scalar patches
    Object.keys(patch).forEach(key => {
      if (key === 'detail') return;
      if (IMMUTABLE_FIELDS.has(key)) return;     // silently dropped
      const colIdx = PATCH_TO_COL[key];
      if (!colIdx) return;                       // unknown / non-core field — ignore

      let newVal = patch[key];
      if (MONEY_FIELDS.has(key)) newVal = Util.roundMoney(Number(newVal) || 0);
      else if (key === 'active') newVal = newVal === true;
      else if (key === 'category') newVal = normalizeCategory_(newVal);
      else newVal = (newVal == null ? '' : newVal.toString()).trim();

      const cur = existing[key];
      const same = (typeof cur === 'number' && typeof newVal === 'number')
        ? Util.roundMoney(cur) === newVal
        : cur === newVal;
      if (same) return;

      sh.getRange(r, colIdx).setValue(newVal);
      before[key] = cur;
      after[key] = newVal;
    });

    const finalCategory = ('category' in after) ? after.category : existing.category;

    if (ProductTypes.has(finalCategory)) {
      // 2a. detail upsert + re-derive
      const hasDetailPatch = patch.detail && typeof patch.detail === 'object';
      if (hasDetailPatch || ('category' in after)) {
        const merged = Object.assign({}, readDetail_(productId, finalCategory), patch.detail || {});

        // core.unit mirrors a detail field (beer → sell_unit)
        const unitFrom = ProductTypes.unitFrom(finalCategory);
        if (unitFrom && merged[unitFrom]) {
          const newUnit = merged[unitFrom].toString().trim();
          if (newUnit && newUnit !== existing.unit && !('unit' in after)) {
            sh.getRange(r, COL.unit).setValue(newUnit);
            before.unit = existing.unit; after.unit = newUnit;
          }
        }

        const resolved = resolvePricing_(finalCategory, patch, merged);
        writeDetail_(productId, existing.sku, finalCategory, merged);
        applyResolved_(sh, r, existing, resolved, before, after);
        after.detail = patch.detail || merged;
      }
    } else {
      // 2b. grocery / other: recompute margin if cost or sell changed
      if ('costPrice' in after || 'sellPrice' in after) {
        const finalCost = ('costPrice' in after) ? after.costPrice : existing.costPrice;
        const finalSell = ('sellPrice' in after) ? after.sellPrice : existing.sellPrice;
        const margin = computeMargin_(finalCost, finalSell);
        sh.getRange(r, COL.margin_amount).setValue(margin.marginAmount);
        sh.getRange(r, COL.margin_pct).setValue(margin.marginPct);
        before.marginAmount = existing.marginAmount;
        before.marginPct = existing.marginPct;
        after.marginAmount = margin.marginAmount;
        after.marginPct = margin.marginPct;
      }
    }

    // 3. stamp + audit only if something actually changed
    if (Object.keys(after).length > 0) {
      const now = new Date();
      sh.getRange(r, COL.updated_by).setValue(actorId);
      sh.getRange(r, COL.updated_at).setValue(now);
      AuditLog.write({
        actorId,
        action: 'product.updated',
        targetType: 'product',
        targetId: productId,
        before, after,
      });
    }

    bustCache_();
    return getById_(productId);
  }

  function deactivate_(productId, actorId) {
    if (!productId) throw new Error('productId required');
    if (!actorId) throw new Error('actorId required');
    const existing = getById_(productId);
    if (!existing) throw new Error('Product not found: ' + productId);
    if (!existing.active) throw new Error('Product is already inactive');
    const sh = sheet_();
    sh.getRange(existing._rowIndex, COL.active).setValue(false);
    sh.getRange(existing._rowIndex, COL.updated_by).setValue(actorId);
    sh.getRange(existing._rowIndex, COL.updated_at).setValue(new Date());
    AuditLog.write({
      actorId,
      action: 'product.deactivated',
      targetType: 'product',
      targetId: productId,
      before: { active: true },
      after: { active: false },
    });
    bustCache_();
    return getById_(productId);
  }

  function reactivate_(productId, actorId) {
    if (!productId) throw new Error('productId required');
    if (!actorId) throw new Error('actorId required');
    const existing = getById_(productId);
    if (!existing) throw new Error('Product not found: ' + productId);
    if (existing.active) throw new Error('Product is already active');
    const sh = sheet_();
    sh.getRange(existing._rowIndex, COL.active).setValue(true);
    sh.getRange(existing._rowIndex, COL.updated_by).setValue(actorId);
    sh.getRange(existing._rowIndex, COL.updated_at).setValue(new Date());
    AuditLog.write({
      actorId,
      action: 'product.reactivated',
      targetType: 'product',
      targetId: productId,
      before: { active: false },
      after: { active: true },
    });
    bustCache_();
    return getById_(productId);
  }

  // ── Per-type import (staging tabs) ────────────────────────
  // CORE staging columns shared by every type. Registry types append
  // their detail input columns; grocery/other appends plain cost/sell.
  const CORE_STAGING_BASE = [
    'sku', 'barcode', 'product_name', 'brand', 'category', 'subcategory',
    'pack_size', 'unit', 'supplier', 'min_sell_price', 'notes', 'source_file',
  ];
  const CORE_STAGING_TO_CAMEL = {
    sku: 'sku', barcode: 'barcode', product_name: 'productName', brand: 'brand',
    category: 'category', subcategory: 'subcategory', pack_size: 'packSize',
    unit: 'unit', supplier: 'supplier', min_sell_price: 'minSellPrice',
    notes: 'notes', source_file: 'sourceFile',
    cost_price: 'costPrice', sell_price: 'sellPrice', sell_price_credit: 'sellPriceCredit',
  };
  const CORE_STAGING_MONEY = new Set(['cost_price', 'sell_price', 'sell_price_credit', 'min_sell_price']);

  // Resolved lazily (inside stagingSheet_) so this module has no load-order
  // dependency on Setup.gs's SHEETS map.
  function stagingSheetName_(type) {
    switch ((type || '').toString().trim().toLowerCase()) {
      case 'beer':       return SHEETS.PM_BEER_STAGING;
      case 'cigarettes': return SHEETS.PM_CIG_STAGING;
      case 'vape':       return SHEETS.PM_VAPE_STAGING;
      case 'other':
      case 'grocery':    return SHEETS.PM_OTHER_STAGING;
      default:           return null;
    }
  }

  // Canonical column order for a type's staging tab. Used by Setup.gs to
  // build headers and by the Python pre-processor (kept in sync there).
  function stagingLayout_(type) {
    const t = (type || '').toString().trim().toLowerCase();
    if (t === 'other' || t === 'grocery') {
      return CORE_STAGING_BASE.concat(['cost_price', 'sell_price', 'sell_price_credit']);
    }
    return CORE_STAGING_BASE.concat(ProductTypes.inputColumns(t));
  }

  function stagingSheet_(type) {
    const name = stagingSheetName_(type);
    if (!name) throw new Error('unknown import type: ' + type);
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (!sh) throw new Error(name + ' sheet not found — run setup / migration');
    return sh;
  }

  function normHeader_(h) { return (h == null ? '' : h.toString()).trim().toLowerCase(); }

  /**
   * Bulk upsert from a type's staging tab (header-driven, so column order
   * is tolerant). Dedup: beer by sku+unit, else sku; SKU-less rows fall
   * back to brand+name. Caps errors at 50. Returns
   *   { imported, updated, skipped, errors:[{rowIndex,message}], errorCount }.
   *
   * @param opts { type (req: beer|cigarettes|vape|other), actorId? }
   */
  function importFromStaging_(opts) {
    opts = opts || {};
    const type = (opts.type || '').toString().trim().toLowerCase();
    if (!type) throw new Error('import type required (beer|cigarettes|vape|other)');
    const actorId = opts.actorId || 'IMPORT';

    const sh = stagingSheet_(type);
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return { imported: 0, updated: 0, skipped: 0, errors: [], errorCount: 0 };

    const lastCol = sh.getLastColumn();
    const headers = sh.getRange(2, 1, 1, lastCol).getValues()[0].map(normHeader_);
    const values = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, lastCol).getValues();
    const detailInputCols = ProductTypes.inputColumns(type);   // [] for other
    const isBeer = type === 'beer';
    const colOf = (name) => headers.indexOf(name);

    // Build the dedup index once (beer keys on sku|unit).
    bustCache_();
    const index = {};
    getAll_(true).forEach(p => {
      if (!p.sku) return;
      const k = isBeer ? (p.sku.toLowerCase() + '|' + (p.unit || '').toLowerCase()) : p.sku.toLowerCase();
      index[k] = p;
    });

    let imported = 0, updated = 0, skipped = 0;
    const errors = [];
    let errorCount = 0;
    const ERROR_CAP = 50;

    values.forEach((row, i) => {
      const rowIndex = DATA_START_ROW + i;
      try {
        const productName = (colOf('product_name') >= 0 ? row[colOf('product_name')] : '').toString().trim();
        // blank row or a pasted CSV header echo → skip silently
        if (!productName || productName.toLowerCase() === 'product_name') return;

        const input = { actorId: actorId };
        Object.keys(CORE_STAGING_TO_CAMEL).forEach(h => {
          const c = colOf(h);
          if (c < 0) return;
          let v = row[c];
          if (CORE_STAGING_MONEY.has(h)) v = Number(v) || 0;
          else v = (v == null ? '' : v.toString()).trim();
          input[CORE_STAGING_TO_CAMEL[h]] = v;
        });
        input.category = (input.category || (type === 'other' ? 'other' : type)).toString().trim().toLowerCase();
        if (!input.sourceFile) input.sourceFile = 'staging:' + type;

        const detail = {};
        detailInputCols.forEach(dc => { const c = colOf(dc); detail[dc] = c >= 0 ? row[c] : ''; });
        input.detail = detail;

        // unit mirror for beer (so the dedup key matches the core row)
        const unitFrom = ProductTypes.unitFrom(input.category);
        let unit = (input.unit || '').toString().trim();
        if (unitFrom && detail[unitFrom]) unit = detail[unitFrom].toString().trim();
        input.unit = unit;

        const sku = (input.sku || '').toString().trim();
        const key = sku ? (isBeer ? (sku.toLowerCase() + '|' + unit.toLowerCase()) : sku.toLowerCase()) : '';
        const existing = key ? index[key] : null;
        if (existing) {
          update_(existing.productId, input, actorId);
          updated++;
          return;
        }

        const dup = findDuplicate_(input, true);
        if (dup) { skipped++; return; }

        create_(input);
        imported++;
      } catch (e) {
        errorCount++;
        if (errors.length < ERROR_CAP) errors.push({ rowIndex: rowIndex, message: e.message });
      }
    });

    AuditLog.write({
      actorId,
      action: 'product.imported',
      targetType: 'product_master',
      targetId: type,
      after: { type, imported, updated, skipped, errorCount },
    });

    return { imported, updated, skipped, errors, errorCount };
  }

  // Debug-only — cache health. Never call from RPCs.
  function cacheStats_() {
    const cache = CacheService.getScriptCache();
    const manifest = cache.get(CACHE_MANIFEST);
    if (!manifest) return { hit: false, chunks: 0, totalBytes: 0 };
    const n = parseInt(manifest, 10) || 0;
    if (n === 0) return { hit: true, chunks: 0, totalBytes: 0, recordCount: 0 };
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(chunkKey_(i));
    const got = cache.getAll(keys);
    let totalBytes = 0;
    let missing = 0;
    let recordCount = 0;
    for (let i = 0; i < n; i++) {
      const blob = got[chunkKey_(i)];
      if (!blob) { missing++; continue; }
      totalBytes += blob.length;
      try { recordCount += JSON.parse(blob).length; } catch (e) {}
    }
    return {
      hit: missing === 0,
      chunks: n,
      missingChunks: missing,
      totalBytes: totalBytes,
      avgChunkBytes: n ? Math.round(totalBytes / n) : 0,
      recordCount: recordCount,
      chunkSize: CACHE_CHUNK_SIZE,
    };
  }

  return {
    // reads
    getAll:                  () => getAll_(false),
    getAllIncludingInactive: () => getAll_(true),
    getById:                 getById_,
    getWithDetail:           getWithDetail_,
    getBySku:                getBySku_,
    search:                  search_,
    // writes
    create:                  create_,
    update:                  update_,
    deactivate:              deactivate_,
    reactivate:              reactivate_,
    // bulk
    importFromStaging:       importFromStaging_,
    stagingLayout:           stagingLayout_,
    // helpers
    computeMargin:           computeMargin_,
    readDetail:              readDetail_,
    VALID_CATEGORIES:        VALID_CATEGORIES.slice(),
    // debug
    _cacheStats:             cacheStats_,
    _bustCache:              bustCache_,
  };
})();
