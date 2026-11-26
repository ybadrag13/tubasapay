'use strict';
// A small stand-in for Turso's HTTP API (Hrana over HTTP, /v2/pipeline), used only by tests.
// It runs on a real SQLite database, so the app's sync and restore can be tested end to end.
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { encode, decode } = require('../server/store');

function startFakeTurso({ token = 'test-token' } = {}) {
  const db = new DatabaseSync(':memory:');
  const state = { failNext: 0, requests: 0, db };

  function execute(stmt) {
    const st = db.prepare(stmt.sql);
    const args = (stmt.args || []).map(decode);
    if (st.columns().length) {
      const cols = st.columns().map((c) => ({ name: c.name, decltype: null }));
      st.setReturnArrays?.(true);
      const rows = st.all(...args).map((r) => (Array.isArray(r) ? r : Object.values(r)).map(encode));
      return { cols, rows, affected_row_count: 0, last_insert_rowid: null };
    }
    const r = st.run(...args);
    return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: String(r.lastInsertRowid) };
  }

  const holds = (cond, ok, err) => {
    if (!cond) return true;
    switch (cond.type) {
      case 'ok': return ok[cond.step] === true;
      case 'error': return err[cond.step] === true;
      case 'not': return !holds(cond.cond, ok, err);
      case 'and': return cond.conds.every((c) => holds(c, ok, err));
      case 'or': return cond.conds.some((c) => holds(c, ok, err));
      default: throw new Error('bad condition');
    }
  };

  function batch(b) {
    const ok = [], err = [], step_results = [], step_errors = [];
    b.steps.forEach((s, i) => {
      if (!holds(s.condition, ok, err)) { step_results.push(null); step_errors.push(null); return; }
      try { step_results.push(execute(s.stmt)); step_errors.push(null); ok[i] = true; }
      catch (e) { step_results.push(null); step_errors.push({ message: e.message }); err[i] = true; }
    });
    return { step_results, step_errors };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests++;
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('unauthorized'); }
      if (req.method !== 'POST' || req.url !== '/v2/pipeline') { res.writeHead(404); return res.end('not found'); }
      if (state.failNext > 0) { state.failNext--; res.writeHead(503); return res.end('temporarily unavailable'); }
      const { requests } = JSON.parse(body);
      const results = requests.map((r) => {
        try {
          if (r.type === 'execute') return { type: 'ok', response: { type: 'execute', result: execute(r.stmt) } };
          if (r.type === 'batch') return { type: 'ok', response: { type: 'batch', result: batch(r.batch) } };
          if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
          return { type: 'error', error: { message: 'unsupported request' } };
        } catch (e) { return { type: 'error', error: { message: e.message } }; }
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.token = token;
    state.close = () => new Promise((r) => server.close(r));
    resolve(state);
  }));
}

module.exports = { startFakeTurso };
