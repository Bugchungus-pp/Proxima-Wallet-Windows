'use strict';
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { nodeURL, holder } = require('./core.cjs');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 10000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 10000 });
const HEX64 = /^[a-f0-9]{64}$/;
// Numbers are not trusted for monetary display. Only opaque output IDs/data are
// hashed here; balances still come from the official, witness-checking engine.
function getJSON(origin, route, { signal, timeout = 2500, maxBytes = 4 * 1024 * 1024 } = {}) {
  const url = new URL(route, nodeURL(origin));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { agent: url.protocol === 'https:' ? httpsAgent : httpAgent, signal, headers: { Accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.resume(); finish(new Error('Node returned HTTP ' + res.statusCode)); return; }
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(); finish(new Error('Node response exceeded safety limit.')); }
        else chunks.push(chunk);
      });
      res.on('error', () => finish(new Error('Node response was interrupted.')));
      res.on('end', () => {
        if (done) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          if (value.error) { finish(new Error('Node API reported an error.')); return; }
          finish(null, value);
        } catch { finish(new Error('Node returned invalid JSON.')); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error('Node check timed out.')); }, timeout);
    req.on('error', () => finish(new Error(signal?.aborted ? 'Refresh cancelled.' : 'Node is unreachable.')));
  });
}
// Pinned upstream ledger/base/id.go: Slot() reads the first four bytes as uint32 BE.
// An LRB is a branch transaction: tick byte 01 (sequencer flag, tick zero).
function lrbSlot(id) {
  if (typeof id !== 'string' || !HEX64.test(id) || id.slice(8, 10) !== '01') return null;
  return Buffer.from(id.slice(0, 8), 'hex').readUInt32BE(0);
}
function outputSnapshot(data) {
  if (!HEX64.test(data.lrbid || '') || (data.outputs !== undefined && !Array.isArray(data.outputs)) || (data.limit_exceeded !== undefined && typeof data.limit_exceeded !== 'boolean')) throw new Error('Invalid wallet snapshot from node.');
  const outputs = data.outputs || [];
  if (outputs.length > 2000) throw new Error('Too many outputs returned by node.');
  const ids = new Set();
  const parts = outputs.map(o => {
    if (!o || !/^[a-f0-9]{66}$/.test(o.id || '') || typeof o.data !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(o.data) || o.data.length > 131072 || ids.has(o.id)) throw new Error('Invalid output returned by node.');
    ids.add(o.id); return o.id + ':' + o.data;
  });
  return { fingerprint: createHash('sha256').update(parts.sort().join('|') + Boolean(data.limit_exceeded)).digest('hex'), branch: data.lrbid, lrbSlot: lrbSlot(data.lrbid), partial: Boolean(data.limit_exceeded) };
}
function inclusion(data, txid) {
  if (data.txid !== txid || !HEX64.test(data.lrbid || '') || !Number.isInteger(data.found_at_depth) || data.found_at_depth < -1 || data.found_at_depth > 1) throw new Error('Invalid transaction status from node.');
  return { txid, branch: data.lrbid, depth: data.found_at_depth, status: data.found_at_depth >= 0 ? 'included' : 'pending' };
}
class Monitor {
  constructor({ get = getJSON, loadBalance, now = Date.now } = {}) {
    this.get = get; this.loadBalance = loadBalance; this.now = now;
    this.generation = 0; this.flight = null; this.controller = null; this.reset();
  }
  reset() {
    this.generation++; this.controller?.abort(); this.cache = null;
    this.fingerprint = null; this.balanceAt = 0; this.last = null;
    this.nextBalanceAt = 0; this.balanceFailures = 0; this.cursor = 0;
  }
  cancel() { this.generation++; this.controller?.abort(); }
  poll({ settings, holderId, history, force = false }) {
    if (this.flight) return this.flight;
    const generation = this.generation;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.flight = this.perform({ settings, holderId, history, force, signal, generation }).finally(() => { this.flight = null; });
    return this.flight;
  }
  async perform({ settings, holderId, history, force, signal, generation }) {
    const origin = nodeURL(settings.nodeUrl);
    const at = this.now();
    let changed = false, branch = null, networkError = null, balanceError = null;
    let snapshot = null;
    try {
      const data = await this.get(origin, '/api/v1/get_outputs?' + new URLSearchParams({ index_value: holder(holderId), lock_type: 'all', max_outputs: '2000' }), { signal });
      snapshot = outputSnapshot(data); branch = snapshot.branch;
      changed = snapshot.fingerprint !== this.fingerprint;
    } catch (err) { networkError = err.message; }
    const refreshBalance = force || changed || !this.cache || at - this.balanceAt >= 30000;
    if (!signal.aborted && refreshBalance && (force || at >= this.nextBalanceAt) && (!networkError || force || !this.cache)) {
      try {
        const result = await this.loadBalance(signal);
        if (generation === this.generation && !signal.aborted) {
          this.cache = result; this.balanceAt = this.now(); this.balanceFailures = 0;
          this.nextBalanceAt = 0; this.fingerprint = snapshot?.fingerprint || null;
        }
      } catch (err) {
        if (signal.aborted || generation !== this.generation) return { cancelled: true };
        balanceError = err.message;
        this.balanceFailures++;
        this.nextBalanceAt = this.now() + Math.min(30000, 3000 * 2 ** Math.min(this.balanceFailures - 1, 4));
      }
    } else if (this.last?.balanceError && at < this.nextBalanceAt) balanceError = this.last.balanceError;
    const relevant = history.filter(h => HEX64.test(h.txid || '') && h.node === origin && !['failed', 'cancelled'].includes(h.status));
    // At most two status requests per poll, rotating so older entries are not starved.
    const selected = [];
    for (let i = 0; i < Math.min(2, relevant.length); i++) selected.push(relevant[(this.cursor + i) % relevant.length]);
    if (relevant.length) this.cursor = (this.cursor + selected.length) % relevant.length;
    const updates = [];
    let transactionError = null;
    if (!signal.aborted && !networkError) {
      await Promise.all(selected.map(async h => {
        try {
          const data = await this.get(origin, '/api/v1/check_txid_in_lrb?' + new URLSearchParams({ txid: h.txid, max_depth: '1' }), { signal, maxBytes: 65536 });
          updates.push({ id: h.id, ...inclusion(data, h.txid), checkedAt: new Date(this.now()).toISOString() });
        } catch (err) { transactionError = err.message; }
      }));
    }
    if (signal.aborted || generation !== this.generation) return { cancelled: true };
    const result = { node: origin, balance: this.cache, checkedAt: new Date(this.now()).toISOString(), branch, lrbSlot: snapshot?.lrbSlot ?? null, networkError, balanceError, transactionError, updates,
      stale: Boolean(networkError || balanceError || (snapshot && snapshot.fingerprint !== this.fingerprint) || !this.cache || this.now() - this.balanceAt >= 30000),
      nextBalanceRetryAt: this.nextBalanceAt || null };
    this.last = result;
    return result;
  }
}
function closeAgents() { httpAgent.destroy(); httpsAgent.destroy(); }
module.exports = { lrbSlot, Monitor, getJSON, outputSnapshot, inclusion, closeAgents };
