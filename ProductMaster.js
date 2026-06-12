// ============================================================
//  ProductMaster.gs — master catalog of products
// ============================================================
//  Multi-category, flat schema. Vape-specific traits (puff count,
//  flavor, e-liquid mL, nicotine strength) are encoded INTO the
//  product_name itself rather than living in sparse columns — keeps
//  the read path category-agnostic.
//
//  margin_amount + margin_pct are derived from cost_price/sell_price
//  and recomputed on every write (never trust the stored values
//  across writes — they exist so spreadsheet users can sort).
//
//  min_sell_price = "discount floor" — the minimum acceptable sell
//  price when any discount is applied. UI flags products whose
//  current sell_price falls below it.
// ============================================================

const ProductMaster = (() => {

  const COL = {
    product_id: 1, sku: 2, barcode: 3, product_name: 4, brand: 5,
    category: 6, subcategory: 7, pack_size: 8, unit: 9,
    cost_price: 10, sell_price: 11, sell_price_credit: 12, min_sell_price: 13,
    margin_amount: 14, margin_pct: 15,
    supplier: 16, last_invoice_no: 17,
    source_file: 18, active: 19, notes: 20,
    created_by: 21, created_at: 22
  };
  const NUM_COLS = 22;
  const DATA_START_ROW = 3;

  // ── Cache strategy ────────────────────────────────────────
  // GAS CacheService caps each entry at ~100 KB. Caching the full record
  // list as one blob blows up around ~600-800 products (~250 bytes/row).
  // We chunk into N entries of CHUNK_SIZE records (~50 KB at 200 rows) plus
  // a manifest key holding the chunk count + a fingerprint. One round-trip
  // for reads (getAll), one for writes (putAll), one for busts (removeAll).
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

  // Read all chunks via a single getAll. Returns null on any miss or
  // inconsistency (e.g. manifest says 6 chunks but chunk 4 has expired
  // independently — treat as cold and re-read the sheet).
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

  // Chunked write. Wrapped in try/catch — on any failure we bust so the
  // next read just re-hits the sheet (correctness > cache hit).
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
    return r;
  }

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PRODUCT_MASTER);
    if (!sh) throw new Error('product_master sheet not found — run First-time Setup');
    return sh;
  }

  function stagingSheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PM_IMPORT_STAGING);
    if (!sh) throw new Error('_pm_import_staging sheet not found — run First-time Setup');
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
      costPrice:       Number(row[COL.cost_price - 1]) || 0,
      sellPrice:       Number(row[COL.sell_price - 1]) || 0,
      sellPriceCredit: Number(row[COL.sell_price_credit - 1]) || 0,
      minSellPrice:    Number(row[COL.min_sell_price - 1]) || 0,
      marginAmount:    Number(row[COL.margin_amount - 1]) || 0,
      marginPct:       Number(row[COL.margin_pct - 1]) || 0,
      supplier:        (row[COL.supplier - 1] || '').toString().trim(),
      lastInvoiceNo:   (row[COL.last_invoice_no - 1] || '').toString().trim(),
      sourceFile:      (row[COL.source_file - 1] || '').toString().trim(),
      active:          row[COL.active - 1] === true,
      notes:           (row[COL.notes - 1] || '').toString(),
      createdBy:       (row[COL.created_by - 1] || '').toString().trim(),
      createdAt:       row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : null,
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
    // Tolerate a couple of stragglers from the import.
    const aliased = c === 'vapes' ? 'vape' : c;
    if (VALID_CATEGORIES.indexOf(aliased) === -1) {
      throw new Error('invalid category: "' + s + '" (expected one of: ' + VALID_CATEGORIES.join(', ') + ')');
    }
    return aliased;
  }

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

  function findDuplicate_(input, includeInactive) {
    const all = getAll_(includeInactive !== false);   // search across all by default
    const sku = (input.sku || '').toString().trim().toLowerCase();
    if (sku) return all.find(r => r.sku && r.sku.toLowerCase() === sku) || null;
    const brand = (input.brand || '').toString().trim().toLowerCase();
    const name = (input.productName || '').toString().trim().toLowerCase();
    if (!name) return null;
    return all.find(r => r.brand.toLowerCase() === brand && r.productName.toLowerCase() === name) || null;
  }

  /**
   * Append a new product row.
   * Dedup: by SKU (case-insensitive) if SKU present, else by brand+name.
   * On dedup match (active OR inactive), returns the existing record and
   * audits product.dedup_hit / product.dedup_hit_inactive — does NOT append.
   *
   * @param input {
   *   sku?, barcode?, productName (req), brand?, category (req),
   *   subcategory?, packSize?, unit?,
   *   costPrice?, sellPrice?, sellPriceCredit?, minSellPrice?,
   *   supplier?, lastInvoiceNo?, notes?,
   *   sourceFile?, actorId (req)
   * }
   */
  function create_(input) {
    if (!input.productName || !input.productName.toString().trim()) {
      throw new Error('productName is required');
    }
    if (!input.actorId) throw new Error('actorId required');
    const category = normalizeCategory_(input.category);

    bustCache_();   // ensure dedup read is fresh
    const existing = findDuplicate_(input, true);
    if (existing) {
      AuditLog.write({
        actorId: input.actorId,
        action: existing.active ? 'product.dedup_hit' : 'product.dedup_hit_inactive',
        targetType: 'product',
        targetId: existing.productId,
        after: {
          dedupKey: input.sku ? 'sku' : 'brand+name',
          attemptedName: input.productName,
          attemptedSku: input.sku || '',
        },
      });
      return existing;
    }

    const productId = Util.newId('PM');
    const costPrice = Util.roundMoney(Number(input.costPrice) || 0);
    const sellPrice = Util.roundMoney(Number(input.sellPrice) || 0);
    const sellPriceCredit = Util.roundMoney(Number(input.sellPriceCredit) || 0);
    const minSellPrice = Util.roundMoney(Number(input.minSellPrice) || 0);
    const margin = computeMargin_(costPrice, sellPrice);
    const now = new Date();

    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      productId,
      (input.sku || '').toString().trim(),
      (input.barcode || '').toString().trim(),
      input.productName.toString().trim(),
      (input.brand || '').toString().trim(),
      category,
      (input.subcategory || '').toString().trim(),
      (input.packSize || '').toString().trim(),
      (input.unit || 'each').toString().trim(),
      costPrice,
      sellPrice,
      sellPriceCredit,
      minSellPrice,
      margin.marginAmount,
      margin.marginPct,
      (input.supplier || '').toString().trim(),
      (input.lastInvoiceNo || '').toString().trim(),
      (input.sourceFile || 'manual').toString().trim(),
      true,
      (input.notes || '').toString(),
      input.actorId,
      now,
    ]]);

    AuditLog.write({
      actorId: input.actorId,
      action: 'product.created',
      targetType: 'product',
      targetId: productId,
      after: {
        sku: input.sku || '',
        productName: input.productName,
        brand: input.brand || '',
        category,
        costPrice, sellPrice, minSellPrice,
        marginAmount: margin.marginAmount,
        marginPct: margin.marginPct,
        sourceFile: input.sourceFile || 'manual',
      },
    });

    bustCache_();
    return getById_(productId);
  }

  // Immutable fields silently dropped from patch
  const IMMUTABLE_FIELDS = new Set([
    'productId', 'sku', 'barcode', 'sourceFile', 'createdBy', 'createdAt',
    'marginAmount', 'marginPct',   // always recomputed; can't be patched directly
  ]);

  // patch keys → COL keys for write-back
  const PATCH_TO_COL = {
    productName:     COL.product_name,
    brand:           COL.brand,
    category:        COL.category,
    subcategory:     COL.subcategory,
    packSize:        COL.pack_size,
    unit:            COL.unit,
    costPrice:       COL.cost_price,
    sellPrice:       COL.sell_price,
    sellPriceCredit: COL.sell_price_credit,
    minSellPrice:    COL.min_sell_price,
    supplier:        COL.supplier,
    lastInvoiceNo:   COL.last_invoice_no,
    notes:           COL.notes,
    active:          COL.active,
  };

  /**
   * Partial update. Only fields in PATCH_TO_COL can be set. Money values
   * are rounded via Util.roundMoney. If cost_price OR sell_price changed,
   * margin is recomputed and both margin_amount/margin_pct are written.
   * One audit row per update with only the fields that actually changed.
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

    Object.keys(patch).forEach(key => {
      if (IMMUTABLE_FIELDS.has(key)) return;     // silently dropped
      const colIdx = PATCH_TO_COL[key];
      if (!colIdx) return;                       // unknown field — ignore

      let newVal = patch[key];
      // Coercion
      if (key === 'costPrice' || key === 'sellPrice' ||
          key === 'sellPriceCredit' || key === 'minSellPrice') {
        newVal = Util.roundMoney(Number(newVal) || 0);
      } else if (key === 'active') {
        newVal = newVal === true;
      } else if (key === 'category') {
        newVal = normalizeCategory_(newVal);
      } else {
        newVal = (newVal == null ? '' : newVal.toString()).trim();
      }

      // Skip if no actual change (defensive — saves a setValue + audit noise)
      const cur = existing[key];
      const same = (typeof cur === 'number' && typeof newVal === 'number')
        ? Util.roundMoney(cur) === newVal
        : cur === newVal;
      if (same) return;

      sh.getRange(r, colIdx).setValue(newVal);
      before[key] = cur;
      after[key] = newVal;
    });

    // Recompute margin if cost or sell changed
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

    // Only audit if something actually changed
    if (Object.keys(after).length > 0) {
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

  /**
   * Bulk import from the _pm_import_staging tab. Reads each staging
   * row, dedups, and calls create_ on miss. Caps errors at 50.
   * Returns { imported, skipped, errors: [{ rowIndex, message }], errorCount }.
   *
   * Staging row layout (22 cols) matches the live tab. Columns the
   * import IGNORES (placeholders in staging):
   *   col 1  product_id    (assigned)
   *   col 14 margin_amount (computed)
   *   col 15 margin_pct    (computed)
   *   col 19 active        (defaults TRUE)
   *   col 21 created_by    (IMPORT or actorId)
   *   col 22 created_at    (now)
   */
  function importFromStaging_(opts) {
    opts = opts || {};
    const actorId = opts.actorId || 'IMPORT';
    const sh = stagingSheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return { imported: 0, skipped: 0, errors: [], errorCount: 0 };

    const rows = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    let imported = 0, skipped = 0;
    const errors = [];
    let errorCount = 0;
    const ERROR_CAP = 50;

    rows.forEach((row, i) => {
      const rowIndex = DATA_START_ROW + i;
      try {
        // Blank row guard: blank productName means empty staging row, skip silently
        const productName = (row[COL.product_name - 1] || '').toString().trim();
        if (!productName) return;

        const input = {
          sku:             (row[COL.sku - 1] || '').toString().trim(),
          barcode:         (row[COL.barcode - 1] || '').toString().trim(),
          productName:     productName,
          brand:           (row[COL.brand - 1] || '').toString().trim(),
          category:        (row[COL.category - 1] || '').toString().trim().toLowerCase(),
          subcategory:     (row[COL.subcategory - 1] || '').toString().trim(),
          packSize:        (row[COL.pack_size - 1] || '').toString().trim(),
          unit:            (row[COL.unit - 1] || 'each').toString().trim(),
          costPrice:       Number(row[COL.cost_price - 1]) || 0,
          sellPrice:       Number(row[COL.sell_price - 1]) || 0,
          sellPriceCredit: Number(row[COL.sell_price_credit - 1]) || 0,
          minSellPrice:    Number(row[COL.min_sell_price - 1]) || 0,
          supplier:        (row[COL.supplier - 1] || '').toString().trim(),
          lastInvoiceNo:   (row[COL.last_invoice_no - 1] || '').toString().trim(),
          notes:           (row[COL.notes - 1] || '').toString(),
          sourceFile:      (row[COL.source_file - 1] || 'staging').toString().trim(),
          actorId:         actorId,
        };

        // Precheck dedup so we can count imported vs skipped accurately
        // (create_ would also dedup, but it returns the existing record
        // and we'd lose the count distinction).
        const dup = findDuplicate_(input, true);
        if (dup) { skipped++; return; }

        create_(input);
        imported++;
      } catch (e) {
        errorCount++;
        if (errors.length < ERROR_CAP) {
          errors.push({ rowIndex: rowIndex, message: e.message });
        }
      }
    });

    AuditLog.write({
      actorId,
      action: 'product.imported',
      targetType: 'product_master',
      targetId: 'bulk',
      after: { imported, skipped, errorCount },
    });

    return { imported, skipped, errors, errorCount };
  }

  // Debug-only — returns { hit, chunks, totalBytes } so the Apps Script
  // editor can verify the chunked cache is healthy. Never call from RPCs.
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
    getBySku:                getBySku_,
    search:                  search_,
    // writes
    create:                  create_,
    update:                  update_,
    deactivate:              deactivate_,
    reactivate:              reactivate_,
    // bulk
    importFromStaging:       importFromStaging_,
    // helpers
    computeMargin:           computeMargin_,
    VALID_CATEGORIES:        VALID_CATEGORIES.slice(),
    // debug
    _cacheStats:             cacheStats_,
    _bustCache:              bustCache_,
  };
})();
