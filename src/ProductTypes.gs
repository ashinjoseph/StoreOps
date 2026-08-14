// ============================================================
//  ProductTypes.gs — per-product-type registry
// ============================================================
//  Each product type (beer, cigarettes, vape) has its OWN detail
//  sheet, its OWN pricing math, and its OWN set of input fields.
//  This registry keeps all of that declarative in one place so the
//  type-agnostic machinery in ProductMaster.gs (cache, audit, dedup,
//  import) doesn't have to fork per type.
//
//  A type config exposes:
//    detailSheet   — name of the 1:1 detail tab (keyed by product_id)
//    detailColumns — ordered snake_case column list for that tab.
//                    Column index in the sheet = array index + 1.
//                    product_id / sku / created_at / updated_at are
//                    system-managed; everything else is a user input.
//    keyFields     — dedup key on the CORE row (default ['sku']).
//    costEditable  — false ⇒ core cost_price is derived, not entered.
//    sellEditable  — false ⇒ core sell_price is derived, not entered.
//    derivePricing(detail) → { costPrice, sellPrice, sellPriceCredit,
//                              marginAmount, marginPct }
//    validate(detail)      → array of error strings (empty = ok)
//    fieldSchema           → [{ key, label, type, ... }] for the UI form
//                            (type: number | percent | text)
//
//  Detail objects use snake_case keys matching detailColumns (the
//  core record stays camelCase — the two never mix). Grocery / other
//  have NO entry here: they are core-only with plain cost/sell/margin.
// ============================================================

const ProductTypes = (() => {

  // marginPct returned as 0..1 — mirrors ProductMaster.computeMargin_.
  function margin_(costPrice, sellPrice) {
    const c = Util.roundMoney(Number(costPrice) || 0);
    const s = Util.roundMoney(Number(sellPrice) || 0);
    const amt = Util.roundMoney(s - c);
    const pct = s > 0 ? Math.round(((s - c) / s) * 10000) / 10000 : 0;
    return { marginAmount: amt, marginPct: pct };
  }

  const n_ = (v) => Number(v) || 0;
  const money_ = (v) => Util.roundMoney(Number(v) || 0);

  // ── Beer ──────────────────────────────────────────────────
  // Source: references/master_beer_sheet.xlsx. Each SKU is listed once
  // per sell_unit (Single, 6-Pack, …) — each listing is its own product
  // row, so the core dedup key is sku + unit.
  //   Sell = Cost/(1 − Margin) + Deposit         (master formula)
  //   Margin is reported EXCLUDING the deposit pass-through.
  // Fallback when Cost is blank: Cost = LCBO Case Price / Units per Case.
  // Detail tab names are literals here (not SHEETS.*) so this registry has
  // no load-order dependency on Setup.gs. They MUST match the SHEETS entries.
  const BEER = {
    detailSheet: 'product_beer_detail',
    detailColumns: [
      'product_id', 'sku', 'sell_unit', 'lcbo_case_price', 'units_per_case',
      'packs_per_case', 'cost_input', 'deposit_per_unit', 'target_margin_pct',
      'created_at', 'updated_at',
    ],
    keyFields: ['sku', 'unit'],
    costEditable: false,
    sellEditable: false,
    unitFrom: 'sell_unit',   // core.unit mirrors this detail field
    derivePricing(d) {
      let cost = money_(d.cost_input);
      if (cost <= 0) {
        const lcbo = n_(d.lcbo_case_price);
        const units = n_(d.units_per_case);
        if (lcbo > 0 && units > 0) cost = Util.roundMoney(lcbo / units);
      }
      const m = n_(d.target_margin_pct);
      const base = (m > 0 && m < 1) ? cost / (1 - m) : cost;
      const deposit = money_(d.deposit_per_unit);
      const sell = Util.roundMoney(base + deposit);
      const mg = margin_(cost, Util.roundMoney(sell - deposit));
      return {
        costPrice: cost, sellPrice: sell, sellPriceCredit: sell,
        marginAmount: mg.marginAmount, marginPct: mg.marginPct,
      };
    },
    validate(d) {
      const errs = [];
      const hasCost = n_(d.cost_input) > 0 ||
        (n_(d.lcbo_case_price) > 0 && n_(d.units_per_case) > 0);
      if (!hasCost) errs.push('beer needs cost_input, or lcbo_case_price + units_per_case');
      return errs;
    },
    fieldSchema: [
      { key: 'sell_unit',         label: 'Sell unit',        type: 'text',    placeholder: 'Single / 6-Pack' },
      { key: 'cost_input',        label: 'Cost $ / unit',    type: 'number',  step: '0.01' },
      { key: 'deposit_per_unit',  label: 'Deposit $ / unit', type: 'number',  step: '0.01', placeholder: '0.10' },
      { key: 'target_margin_pct', label: 'Target margin',    type: 'percent' },
      { key: 'lcbo_case_price',   label: 'LCBO case price $', type: 'number', step: '0.01' },
      { key: 'units_per_case',    label: 'Units / case',     type: 'number',  step: '1' },
      { key: 'packs_per_case',    label: 'Packs / case',     type: 'number',  step: '1' },
    ],
  };

  // ── Cigarettes ────────────────────────────────────────────
  // Source: references/master_cigarette_sheet.xlsx. Tobacco tax is baked
  // into Cost/Carton; no deposit.
  //   Cost/Pack = Cost/Carton / Packs/Carton
  //   Sell/Pack = Cost/Pack / (1 − Margin)
  const CIGARETTES = {
    // pack_size (20s / 25s) lives in the CORE sheet — don't duplicate it here.
    detailSheet: 'product_cigarettes_detail',
    detailColumns: [
      'product_id', 'sku', 'cost_per_carton', 'packs_per_carton',
      'target_margin_pct', 'review_sold', 'created_at', 'updated_at',
    ],
    keyFields: ['sku'],
    costEditable: false,
    sellEditable: false,
    derivePricing(d) {
      const packs = n_(d.packs_per_carton);
      const costCarton = money_(d.cost_per_carton);
      const costPerPack = packs > 0 ? Util.roundMoney(costCarton / packs) : 0;
      const m = n_(d.target_margin_pct);
      const sell = (m > 0 && m < 1) ? Util.roundMoney(costPerPack / (1 - m)) : costPerPack;
      const mg = margin_(costPerPack, sell);
      return {
        costPrice: costPerPack, sellPrice: sell, sellPriceCredit: sell,
        marginAmount: mg.marginAmount, marginPct: mg.marginPct,
      };
    },
    validate(d) {
      const errs = [];
      if (n_(d.cost_per_carton) <= 0) errs.push('cigarettes need cost_per_carton > 0');
      if (n_(d.packs_per_carton) <= 0) errs.push('cigarettes need packs_per_carton > 0');
      return errs;
    },
    fieldSchema: [
      { key: 'cost_per_carton',   label: 'Cost $ / carton',  type: 'number', step: '0.01' },
      { key: 'packs_per_carton',  label: 'Packs / carton',   type: 'number', step: '1' },
      { key: 'target_margin_pct', label: 'Target margin',    type: 'percent' },
      { key: 'review_sold',       label: 'Review flag',      type: 'text',   placeholder: 'REVIEW' },
    ],
  };

  // ── Vape ──────────────────────────────────────────────────
  // Source: YV Vape Master Price List.xlsx. Prices are GIVEN (not derived);
  // attributes (puffs / mL / nicotine / flavor) get real columns instead of
  // being crammed into product_name.
  const VAPE = {
    detailSheet: 'product_vape_detail',
    detailColumns: [
      'product_id', 'sku', 'product_line', 'form_factor', 'puffs', 'eliquid_ml',
      'nicotine', 'flavor', 'purchase_price', 'sale_price', 'sale_price_credit',
      'last_invoice_no', 'created_at', 'updated_at',
    ],
    keyFields: ['sku'],
    costEditable: false,
    sellEditable: false,
    derivePricing(d) {
      const cost = money_(d.purchase_price);
      const sell = money_(d.sale_price);
      const credit = d.sale_price_credit ? money_(d.sale_price_credit) : sell;
      const mg = margin_(cost, sell);
      return {
        costPrice: cost, sellPrice: sell, sellPriceCredit: credit,
        marginAmount: mg.marginAmount, marginPct: mg.marginPct,
      };
    },
    validate(d) {
      const errs = [];
      if (n_(d.sale_price) <= 0) errs.push('vape needs sale_price > 0');
      return errs;
    },
    fieldSchema: [
      { key: 'product_line',      label: 'Product line', type: 'text' },
      { key: 'form_factor',       label: 'Form factor',  type: 'text',   placeholder: 'Disposable' },
      { key: 'flavor',            label: 'Flavor',       type: 'text' },
      { key: 'puffs',             label: 'Puffs',        type: 'number', step: '1' },
      { key: 'eliquid_ml',        label: 'E-liquid mL',  type: 'number', step: '0.1' },
      { key: 'nicotine',          label: 'Nicotine',     type: 'text',   placeholder: '2%' },
      { key: 'purchase_price',    label: 'Purchase $',   type: 'number', step: '0.01' },
      { key: 'sale_price',        label: 'Sale $',       type: 'number', step: '0.01' },
      { key: 'sale_price_credit', label: 'Sale $ (credit)', type: 'number', step: '0.01' },
      { key: 'last_invoice_no',   label: 'Last invoice #', type: 'text' },
    ],
  };

  const REGISTRY = { beer: BEER, cigarettes: CIGARETTES, vape: VAPE };

  function get_(category) {
    return REGISTRY[(category || '').toString().trim().toLowerCase()] || null;
  }
  function has_(category) { return !!get_(category); }

  // System columns the generic detail writer fills itself.
  const SYSTEM_DETAIL_COLS = new Set(['product_id', 'sku', 'created_at', 'updated_at']);

  // Input (user-editable) detail columns for a type, in sheet order.
  function inputColumns_(category) {
    const cfg = get_(category);
    if (!cfg) return [];
    return cfg.detailColumns.filter(c => !SYSTEM_DETAIL_COLS.has(c));
  }

  // Numeric input columns (anything declared number/percent in fieldSchema).
  function numericColumns_(category) {
    const cfg = get_(category);
    if (!cfg) return [];
    return cfg.fieldSchema.filter(f => f.type === 'number' || f.type === 'percent').map(f => f.key);
  }

  // UI form descriptor for a category. Registry types are derived
  // (cost/sell read-only); grocery/other are plain cost/sell/margin.
  function schemaFor_(category) {
    const cat = (category || '').toString().trim().toLowerCase();
    const cfg = get_(cat);
    if (!cfg) {
      return { category: cat, costEditable: true, sellEditable: true, detailFields: [] };
    }
    return {
      category: cat,
      costEditable: false,   // registry types: cost is derived from detail inputs
      sellEditable: false,   // registry types: sell is derived from detail inputs
      unitFrom: cfg.unitFrom || null,
      detailFields: cfg.fieldSchema.map(f => Object.assign({}, f)),
    };
  }

  return {
    has:            has_,
    get:            get_,
    detailSheet:    (cat) => { const c = get_(cat); return c ? c.detailSheet : null; },
    detailColumns:  (cat) => { const c = get_(cat); return c ? c.detailColumns.slice() : []; },
    inputColumns:   inputColumns_,
    numericColumns: numericColumns_,
    keyFields:      (cat) => { const c = get_(cat); return c ? c.keyFields.slice() : ['sku']; },
    unitFrom:       (cat) => { const c = get_(cat); return c ? (c.unitFrom || null) : null; },
    derivePricing:  (cat, detail) => { const c = get_(cat); return c ? c.derivePricing(detail || {}) : null; },
    validate:       (cat, detail) => { const c = get_(cat); return c ? c.validate(detail || {}) : []; },
    schemaFor:      schemaFor_,
    SYSTEM_DETAIL_COLS,
  };
})();
