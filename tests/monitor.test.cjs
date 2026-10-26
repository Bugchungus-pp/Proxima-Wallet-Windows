'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Monitor, outputSnapshot, inclusion, lrbSlot } = require('../desktop/monitor.cjs');
const { DEFAULTS, sendAmount, FEE_FLOOR } = require('../desktop/core.cjs');
const branch = 'aa'.repeat(32), txid = 'bb'.repeat(32);
const output = { id: 'ab'.repeat(33), data: '000102' };
const args = { settings: DEFAULTS, holderId: 'cc'.repeat(32), history: [] };
const balance = { motes: '123456789', outputs: '1', fetchedAt: new Date(100000).toISOString() };
test('wallet minimum and fee floor use exact integer motes', () => {
 assert.equal(sendAmount('10'), '10000000');
 assert.equal(sendAmount('10.000001'), '10000001');
 assert.throws(() => sendAmount('9.999999'), /Minimum send/);
 assert.equal(FEE_FLOOR, 100000n);
});
test('snapshot fingerprint ignores branch and ordering, rejects malformed data', () => {
 const another = { id: 'cd'.repeat(33), data: 'abcd' };
 assert.equal(outputSnapshot({ lrbid: branch, outputs: [output, another] }).fingerprint, outputSnapshot({ lrbid: txid, outputs: [another, output] }).fingerprint);
 for (const value of [{}, { lrbid: branch, outputs: [output, output] }, { lrbid: branch, outputs: [{ id: output.id, data: 'zz' }] }]) assert.throws(() => outputSnapshot(value));
});
test('unchanged wallet avoids native processes; changes and periodic rechecks refresh', async () => {
 let now = 100000, nativeCalls = 0, outputs = [output];
 const m = new Monitor({ now: () => now, get: async () => ({ lrbid: branch, outputs }), loadBalance: async () => { nativeCalls++; return balance; } });
 assert.equal((await m.poll(args)).stale, false); assert.equal(nativeCalls, 1);
 now += 3000; await m.poll(args); assert.equal(nativeCalls, 1);
 outputs = []; now += 3000; await m.poll(args); assert.equal(nativeCalls, 2);
 now += 30000; await m.poll(args); assert.equal(nativeCalls, 3);
 await m.poll({ ...args, force: true }); assert.equal(nativeCalls, 4);
});
test('concurrent refreshes share one operation', async () => {
 let release, calls = 0;
 const m = new Monitor({ get: async () => { calls++; await new Promise(r => { release = r; }); return { lrbid: branch }; }, loadBalance: async () => balance });
 const p = m.poll(args), second = m.poll(args);
 assert.equal(p, second); release(); await p; assert.equal(calls, 1);
});
test('offline retains last balance and reports stale, not zero', async () => {
 let offline = false;
 const m = new Monitor({ get: async () => { if (offline) throw new Error('offline'); return { lrbid: branch }; }, loadBalance: async () => balance });
 await m.poll(args); offline = true;
 const r = await m.poll(args);
 assert.equal(r.balance.motes, balance.motes); assert.equal(r.stale, true); assert.equal(r.networkError, 'offline');
});
test('native failures back off without clearing the verified balance', async () => {
 let now = 100000, calls = 0, fail = false, outputs = [];
 const m = new Monitor({ now: () => now, get: async () => ({ lrbid: branch, outputs }), loadBalance: async () => { calls++; if (fail) throw new Error('witness unavailable'); return balance; } });
 await m.poll(args); fail = true; outputs = [output];
 const failed = await m.poll(args); assert.equal(failed.stale, true); assert.equal(failed.balance.motes, balance.motes);
 now += 100; await m.poll(args); assert.equal(calls, 2);
 now += 3000; await m.poll(args); assert.equal(calls, 3);
 fail = false; now += 6000; assert.equal((await m.poll(args)).stale, false);
});
test('reset cancels old generation without restoring its cache', async () => {
 let release;
 const m = new Monitor({ get: async () => { await new Promise(r => { release = r; }); return { lrbid: branch }; }, loadBalance: async () => balance });
 const pending = m.poll(args); m.reset(); release();
 assert.equal((await pending).cancelled, true); assert.equal(m.cache, null);
});
test('transaction checks are bounded and node-scoped, including disappearance', async () => {
 const history = [1,2,3].map(n => ({ id: String(n), txid: String(n).repeat(64), node: DEFAULTS.nodeUrl, status: 'submitted' }));
 history.push({ id: 'foreign', txid, node: 'https://other.example', status: 'submitted' });
 let depth = 0;
 const m = new Monitor({ get: async (_origin, route) => route.includes('get_outputs') ? { lrbid: branch } : { txid: new URL(route, 'http://test').searchParams.get('txid'), lrbid: branch, found_at_depth: depth }, loadBalance: async () => balance });
 const first = await m.poll({ ...args, history });
 assert.deepEqual(first.updates.map(u => u.id), ['1','2']); assert.equal(first.updates[0].status, 'included');
 depth = -1; const next = await m.poll({ ...args, history });
 assert.deepEqual(next.updates.map(u => u.id), ['3','1']); assert.equal(next.updates[0].status, 'pending');
 assert.throws(() => inclusion({ txid: branch, lrbid: branch, found_at_depth: 0 }, txid));
 assert.throws(() => inclusion({ txid, lrbid: branch, found_at_depth: 2 }, txid));
});

test('LRB slot follows upstream uint32 big-endian encoding, including high bit', () => {
 const id = prefix => prefix + '01' + 'ab'.repeat(27);
 assert.equal(lrbSlot(id('00000000')), 0);
 assert.equal(lrbSlot(id('0001e240')), 123456);
 assert.equal(lrbSlot(id('80000000')), 2147483648);
 assert.equal(lrbSlot(id('ffffffff')), 4294967295);
 for (const value of [null, '', 'xx'.repeat(32), '00'.repeat(32), 'aa'.repeat(32), id('00000001') + '00']) assert.equal(lrbSlot(value), null);
});
test('LRB slot changes on each poll without rerunning balance, and clears offline', async () => {
 let slot = '0001e240', offline = false, calls = 0;
 const m = new Monitor({ get: async () => {
  if (offline) throw new Error('offline');
  return { lrbid: slot + '01' + 'ab'.repeat(27), outputs: [] };
 }, loadBalance: async () => { calls++; return balance; } });
 assert.equal((await m.poll(args)).lrbSlot, 123456);
 slot = '0001e241'; assert.equal((await m.poll(args)).lrbSlot, 123457);
 assert.equal(calls, 1);
 offline = true; assert.equal((await m.poll(args)).lrbSlot, null);
});
