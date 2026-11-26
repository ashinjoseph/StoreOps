// transport.js — gives the page a google.script.run that talks HTTP.
//
// The page was written against Apps Script's google.script.run. This file
// supplies the same surface (withSuccessHandler, withFailureHandler,
// withUserObject, then any RPC name) over POST /rpc/<name>. When the page is
// running inside Apps Script, google.script.run already exists and this file
// does nothing.
//
// Wire format: request body {"args": [...]}. Answers:
//   {"ok": true,  "result": <json>}
//   {"ok": false, "error": {"message": "..."}}
// A failure handler always receives an Error whose message is the server's
// message, or NETWORK_ERROR when there is no readable answer.
(function () {
  if (window.google && window.google.script && window.google.script.run) return;

  const NETWORK_ERROR = 'NETWORK_ERROR';

  // Read an answer into { ok, result } or { ok: false, message }.
  function parse(res, text) {
    let body;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    if (body && body.ok === true && res.ok) return { ok: true, result: body.result === undefined ? null : body.result };
    if (body && body.ok === false && body.error && typeof body.error.message === 'string') {
      return { ok: false, message: body.error.message };
    }
    return { ok: false, message: NETWORK_ERROR };
  }

  function settle(answer, success, failure, user) {
    // Handlers run outside the request's promise chain so that one that
    // throws can never be taken for a failed call.
    if (answer.ok) {
      if (!success) return;
      try { success(answer.result, user); } catch (e) { console.error(e); }
      return;
    }
    const err = new Error(answer.message);
    if (!failure) { console.error(err.message); return; }
    try { failure(err, user); } catch (e) { console.error(e); }
  }

  function send(method, args, success, failure, user) {
    let answer;
    fetch('/rpc/' + encodeURIComponent(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: args }),
    })
      .then(res => res.text().then(text => parse(res, text)))
      .catch(() => ({ ok: false, message: NETWORK_ERROR }))
      .then(a => { answer = a; })
      .then(() => settle(answer, success, failure, user));
  }

  // Each step returns a fresh, immutable chain, so handlers never leak
  // between calls started from the same google.script.run.
  function chain(success, failure, user) {
    return new Proxy({}, {
      get(_, name) {
        if (typeof name !== 'string' || name === 'then') return undefined;
        if (name === 'withSuccessHandler') return fn => chain(fn, failure, user);
        if (name === 'withFailureHandler') return fn => chain(success, fn, user);
        if (name === 'withUserObject') return obj => chain(success, failure, obj);
        return (...args) => { send(name, args, success, failure, user); };
      },
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = chain(null, null, undefined);
})();
