'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { run, environment } = require('../desktop/process.cjs');
function mock() {
 const child = new EventEmitter();
 child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
 child.killed = false; child.kill = () => { child.killed = true; };
 const writes = [];
 child.stdin.on('data', x => writes.push(x.toString()));
 return { child, writes, spawnFn: (_exe, _args, opts) => { assert.equal(opts.shell, false); return child; } };
}
const tick = () => new Promise(r => setImmediate(r));
test('split confirmation waits for explicit approval; stdin is not closed', async () => {
 const m = mock(); let approve; const decision = new Promise(r => { approve = r; });
 const result = run('proxi', [], { spawnFn: m.spawnFn, approve: () => decision });
 m.child.stdout.write('send will cost 10 of fees paid to ');
 m.child.stdout.write('tag-along sequencer abc. Proceed? (Y/n) ');
 await tick(); assert.deepEqual(m.writes, []); assert.equal(m.child.stdin.writableEnded, false);
 approve(true); await tick(); assert.deepEqual(m.writes, ['y\n']);
 m.child.emit('close', 0); await result;
});
test('cancellation is explicit n, never EOF or a default yes', async () => {
 const m = mock(); const result = run('proxi', [], { spawnFn: m.spawnFn, approve: async () => false });
 m.child.stdout.write('send to the unknown holder anyway? (y/N) '); await tick();
 assert.deepEqual(m.writes, ['n\n']); assert.equal(m.child.stdin.writableEnded, false);
 m.child.emit('close', 0); await result;
});
test('unknown recipient and fee are separately approved', async () => {
 const m = mock(); const seen = [];
 const result = run('proxi', [], { spawnFn: m.spawnFn, approve: async p => { seen.push(p.kind); return true; } });
 m.child.stdout.write('send to the unknown holder anyway? (y/N) '); await tick();
 m.child.stdout.write('\nsource: wallet\nsend will cost 1_000 of fees paid to tag-along sequencer abc. Proceed? (Y/n) '); await tick();
 assert.deepEqual(seen, ['unknown', 'fee']); assert.deepEqual(m.writes, ['y\n', 'y\n']);
 m.child.emit('close', 0); await result;
});
test('repeated fee confirmation kills process', async () => {
 const m = mock(); const result = run('proxi', [], { spawnFn: m.spawnFn, approve: async () => true });
 const rejected = assert.rejects(result, /repeated confirmation/);
 const p = '\nsend will cost 1 of fees paid to tag-along sequencer abc. Proceed? (Y/n) ';
 m.child.stdout.write(p); await tick(); m.child.stdout.write(p);
 await rejected; assert.equal(m.child.killed, true);
});
test('unrecognized prompt times out without approving or retrying', async () => {
 const m = mock(); const result = run('proxi', [], { spawnFn: m.spawnFn, approve: async () => { throw new Error('must not approve'); }, timeout: 30 });
 m.child.stdout.write('Delete the wallet? (Y/n) ');
 await assert.rejects(result, /timed out/); assert.deepEqual(m.writes, []); assert.equal(m.child.killed, true);
});
test('timed-out approval cannot write to killed process later', async () => {
 const m = mock(); let decide;
 const result = run('proxi', [], { spawnFn: m.spawnFn, timeout: 30, approve: () => new Promise(r => { decide = r; }) });
 m.child.stdout.write('send to the unknown holder anyway? (y/N) ');
 await assert.rejects(result, /timed out/); decide(true); await tick(); assert.deepEqual(m.writes, []);
});
test('engine errors and oversized outputs fail explicitly', async () => {
 const m = mock(); const result = run('proxi', [], { spawnFn: m.spawnFn });
 m.child.stderr.write('Error: node offline'); m.child.emit('close', 1);
 await assert.rejects(result, /node offline/);
 const big = mock(); const huge = run('proxi', [], { spawnFn: big.spawnFn });
 big.child.stdout.write('x'.repeat(1024 * 1024 + 1)); await assert.rejects(huge, /safety limit/);
});
test('environment does not leak unrelated tokens or enable inherited force', () => {
 const old = process.env.FORCE; process.env.FORCE = 'true';
 const env = environment('secret');
 assert.equal(env.FORCE, undefined); assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.PROXIMA_KEY_PASSPHRASE, 'secret');
 if (old === undefined) delete process.env.FORCE; else process.env.FORCE = old;
});

test('delegation approvals are separate and authorized receipt stops inclusion watcher', async () => {
 const core = require('../desktop/core.cjs'); const m = mock(); const seen = [];
 const result = run('proxi', [], { spawnFn: m.spawnFn, approve: async p => { seen.push(p.kind); return true; }, parsePrompt: core.delegationPrompt, promptOrder: ['allowance', 'stop'], stopOnReceipt: core.submissionReceipt });
 m.child.stdout.write('authorise sequencer $/e1e1e1e1e1e1.. to take up to 200_000 out of delegation $/d1d1d1d1d1d1..? (Y/n) '); await tick();
 m.child.stdout.write('send request to stop delegation $/d1d1d1d1d1d1.. to the sequencer $/' + 'e1'.repeat(24) + '? (Y/n) '); await tick();
 assert.deepEqual(seen, ['allowance', 'stop']); assert.deepEqual(m.writes, ['y\n', 'y\n']);
 m.child.stdout.write('\n-------- tx OK ' + 'ab'.repeat(32) + ' (len = 200)');
 assert.ok((await result).includes('tx OK')); assert.equal(m.child.killed, true);
});
test('premature receipt and repeated delegation confirmations fail closed', async () => {
 const core = require('../desktop/core.cjs');
 const m = mock(); const result = run('proxi', [], { spawnFn: m.spawnFn, approve: async () => true, parsePrompt: core.delegationPrompt, promptOrder: ['withdraw'], stopOnReceipt: core.submissionReceipt });
 m.child.stdout.write('\n-------- tx OK ' + 'ab'.repeat(32) + ' (len = 200)');
 await assert.rejects(result, /before authorization/); assert.deepEqual(m.writes, []);
 const n = mock(); const repeated = run('proxi', [], { spawnFn: n.spawnFn, approve: async () => true, parsePrompt: core.delegationPrompt, promptOrder: ['withdraw'] });
 const rejection = assert.rejects(repeated, /repeated/);
 const prompt = 'discontinue chain $/' + 'ab'.repeat(24) + '? (Y/n) ';
 n.child.stdout.write(prompt); await tick(); n.child.stdout.write(prompt); await rejection;
});
