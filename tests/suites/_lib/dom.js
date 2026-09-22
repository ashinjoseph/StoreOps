// ============================================================
//  dom — just enough of a document for the close sheet
// ============================================================
//  The client builds its sheets as HTML strings and then reaches back into
//  them by id. That is testable without a browser: parse the ids (and the
//  values the markup seeds them with) out of the string the code produced,
//  hand back element stubs, and let the real listeners run against them.
// ============================================================

function el(id) {
  const node = {
    id: id,
    value: '',
    textContent: '',
    className: '',
    disabled: false,
    style: { display: '' },
    _listeners: {},
    _classes: [],
    classList: {
      add(c) { if (node._classes.indexOf(c) === -1) node._classes.push(c); },
      remove(c) { node._classes = node._classes.filter(x => x !== c); },
      contains(c) { return node._classes.indexOf(c) !== -1; },
      toggle(c, on) {
        const want = on === undefined ? !node.classList.contains(c) : !!on;
        if (want) node.classList.add(c); else node.classList.remove(c);
        return want;
      },
    },
    addEventListener(type, fn) {
      (node._listeners[type] = node._listeners[type] || []).push(fn);
    },
    focus() { node._focused = true; },
    select() { node._selected = true; },
  };
  return node;
}

/** Fire every listener registered for `type`, plus an `on<type>` handler. */
function fire(node, type) {
  if (!node) throw new Error('fire on a missing element');
  (node._listeners[type] || []).forEach(fn => fn({ target: node }));
  const direct = node['on' + type];
  if (typeof direct === 'function') direct({ target: node });
  return node;
}

/**
 * Build a registry from rendered markup: every id="…" becomes an element,
 * seeded with the value="…" the markup gave it so a field's resting value is
 * whatever the page would really show.
 */
function fromHTML(html) {
  const nodes = {};
  const src = String(html || '');
  const tag = /<[^>]*\bid="([^"]+)"[^>]*>/g;
  let m;
  while ((m = tag.exec(src))) {
    const node = el(m[1]);
    const val = /\bvalue="([^"]*)"/.exec(m[0]);
    if (val) node.value = val[1];
    // Honour the markup's own starting state: a row the page ships hidden must
    // read as hidden here, or a test can't tell "revealed" from "never hid".
    const style = /\bstyle="([^"]*)"/.exec(m[0]);
    if (style && /display\s*:\s*none/.test(style[1])) node.style.display = 'none';
    // A label the element carries in its own markup — the sign button ships
    // showing "+". Only plain text counts; anything with a child element is
    // built by the code, not the string.
    const after = src.slice(tag.lastIndex);
    const text = /^([^<]*)</.exec(after);
    if (text && text[1].trim()) node.textContent = text[1].trim();
    nodes[m[1]] = node;
  }
  return {
    nodes: nodes,
    get(id) { return nodes[id] || null; },
    // The client's own $ helper: unknown ids must come back null, not throw,
    // so a sheet that stopped rendering a field fails on the assertion rather
    // than inside the stub.
    $(id) { return nodes[id] || null; },
    type(id, text) {
      const node = nodes[id];
      if (!node) throw new Error('no such field: ' + id);
      node.value = String(text);
      fire(node, 'input');
      return node;
    },
    blur(id) { return fire(nodes[id], 'blur'); },
    fire: fire,
    has(id) { return !!nodes[id]; },
    ids() { return Object.keys(nodes); },
  };
}

module.exports = { el, fire, fromHTML };
