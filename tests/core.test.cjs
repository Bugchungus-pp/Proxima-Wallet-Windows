'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../desktop/core.cjs');
test('PROX amounts preserve precision above Number.MAX_SAFE_INTEGER', () => {
 assert.equal(c.toMotes('9007199254.740993'), '9007199254740993');
 assert.equal(c.toMotes('0.000001'), '1');
 assert.equal(c.toMotes('18446744073709.551615'), c.MAX.toString());
 assert.equal(c.fromMotes('9007199254740993'), '9007199254.740993');
});
test('invalid and overflowing amounts fail closed', () => {
 for (const n of ['0', '-1', '1e6', '1,000', '1.0000001', '01', '.1', ' 1', 'Infinity', 'NaN', '18446744073709.551616', '', null, 1]) assert.throws(() => c.toMotes(n));
});
test('wallet IDs are normalized without permitting command injection', () => {
 const id = 'ab'.repeat(32);
 assert.equal(c.holder('a/' + id.toUpperCase()), id);
 for (const v of ['--force', id + ';', 'c/' + id, 'ff', null]) assert.throws(() => c.holder(v));
});
test('node URL validation rejects credentials and non-HTTP schemes', () => {
 assert.equal(c.nodeURL('https://node.example:443/'), 'https://node.example');
 for (const v of ['file:///tmp/a', 'javascript:alert(1)', 'https://u:p@host', 'https://node/a', 'https://node/?a=1', 'https://node/#x', 'bad']) assert.throws(() => c.nodeURL(v));
});
test('at least one distinct witness is mandatory', () => {
 const v = c.settings(c.DEFAULTS);
 assert.equal(v.witnesses.length, 2);
 assert.throws(() => c.settings({ nodeUrl: 'http://a', witnesses: ['http://a/'] }));
 assert.throws(() => c.settings({ ...c.DEFAULTS, sequencer: '--force' }));
 assert.throws(() => c.settings({ ...c.DEFAULTS, witnesses: [] }));
});
test('generated profile contains no key or password', () => {
 const p = JSON.parse(c.profile(c.DEFAULTS, 'ab'.repeat(32)));
 assert.equal(p.wallet.key_file, 'proxima.key');
 assert.equal(p.api.node_urls.length, 2);
 assert.equal(p.tag_along.fee, 100000);
 assert.equal(p.wallet.private_key, undefined);
});
test('balance does not silently convert errors to zero', () => {
 assert.deepEqual(c.balance('TOTAL controlled on 2 outputs: 9_007_199_254_740_993'), { motes: '9007199254740993', outputs: '2', partial: false });
 assert.equal(c.balance('WARNING: results are partial\nTOTAL controlled on 4 outputs: 10').partial, true);
 assert.throws(() => c.balance('Error: connection refused'));
});
test('prompt parser recognizes only official prompts with bounded fees', () => {
 assert.equal(c.prompt('send to the unknown holder anyway? (y/N) ').kind, 'unknown');
 assert.equal(c.prompt('send will cost 1_000 of fees paid to tag-along sequencer [abc]. Proceed? (Y/n) ').fee, '1000');
 assert.equal(c.prompt('Proceed? (Y/n) '), null);
 assert.equal(c.prompt('send will cost 10'), null);
 assert.throws(() => c.prompt('send will cost 18446744073709551616 of fees paid to tag-along sequencer abc. Proceed? (Y/n) '));
});
test('receipt requires successful submission and a complete transaction ID', () => {
 const id = 'ab'.repeat(32);
 assert.equal(c.receipt(`-------- tx OK ${id} (len = 220) -----------\ntransaction abc submitted successfully`), id);
 assert.equal(c.receipt('transaction abc submitted successfully'), null);
 assert.equal(c.receipt(`-------- tx OK ${id} (len = 220)`), null);
});
test('password policy limits input and requires 12 bytes for new keys', () => {
 assert.throws(() => c.password('short', true));
 assert.throws(() => c.password('a'.repeat(1025)));
 assert.throws(() => c.password('hello\0world', true));
 assert.equal(c.password('a secure passphrase', true), 'a secure passphrase');
});

const delegationID = 'd1'.repeat(24), targetID = 'e1'.repeat(24);
const sampleBalance = `Current slot is 123456
SUMMARY controlled by test:
    on  3 non-chain outputs:            40_000_000
    on  1 delegation outputs:           60_000_000
    on  0 non-delegation chain outputs: 0
TOTAL controlled on 4 outputs: 100_000_000
DELEGATIONS (1):
  $/${delegationID} 60_000_000 frozen until slot 123999 (90 min from now) maxFrozen: 3
       delegation target $/${targetID}
NO NATIVE TOKENS
NO FOUNDRIES`;
const stopReport = `delegation target ID: $/${targetID}
delegation $/${delegationID.slice(0,12)}.. -> $/${targetID.slice(0,12)}.., unfreezes in slot 123999, balance 60_000_000
   estimated compensation to the sequencer: 300_000
   paid from this wallet (tag-along fee): 100_000
   taken from the delegation (allowance): 200_000
`;
test('detailed balance preserves categories and complete delegation identity', () => {
 const b = c.balanceDetails(sampleBalance);
 assert.equal(b.delegatedMotes, '60000000'); assert.equal(b.nonChainMotes, '40000000');
 assert.deepEqual(b.delegations[0], { id: delegationID, target: targetID, motes: '60000000', frozen: true, unfreezeSlot: 123999, status: 'frozen until slot 123999 (90 min from now)' });
 assert.equal(c.balanceDetails(sampleBalance.replace('frozen until slot 123999 (90 min from now)', 'on hold')).delegations[0].frozen, false);
 assert.throws(() => c.balanceDetails(sampleBalance.replace('TOTAL controlled on 4', 'TOTAL controlled on 5')), /Inconsistent/);
 assert.throws(() => c.balanceDetails(sampleBalance.replace('60_000_000 frozen', '61_000_000 frozen')), /Incomplete/);
 assert.throws(() => c.balanceDetails(sampleBalance.replace('DELEGATIONS (1)', 'DELEGATIONS (2)')), /Missing/);
});
test('spendable scan excludes chains and distinguishes reclaimable tag-alongs', () => {
 const scan = `COMPACTION SCAN of test
    windows evaluated at slot 123456; 4 UTXO(s) indexed under this account
    YOURS, COMPACTABLE   count               tokens
      tagalong-cleanup    1 100_000 public
      tagalong-reclaim    1 100_000
      siglock             1 39_800_000
    YOURS, NOT COMPACTABLE
      on chains           1 60_000_000 delegations
`;
 assert.deepEqual(c.spendableScan(scan), { spendableMotes: '39800000', tagAlongReclaimableMotes: '200000', scanSlot: 123456, scanPartial: false });
 assert.equal(c.spendableScan(scan + '\nLOWER BOUND').scanPartial, true);
 assert.throws(() => c.spendableScan(scan + '\nPUBLIC, ABANDONED'), /Unrecognized/);
 assert.throws(() => c.spendableScan(scan.replace('4 UTXO', '5 UTXO')), /Incomplete/);
 assert.throws(() => c.spendableScan('node offline'));
});
test('delegation cost parsing requires matching identities and exact totals', () => {
 assert.deepEqual(c.stopCosts(stopReport, delegationID), { target: targetID, fee: '100000', allowance: '200000', compensation: '300000', motes: '60000000' });
 assert.throws(() => c.stopCosts(stopReport, 'aa'.repeat(24)), /identity/);
 assert.throws(() => c.stopCosts(stopReport.replace('compensation to the sequencer: 300_000', 'compensation to the sequencer: 1'), delegationID), /Inconsistent/);
 const withdraw = `using profile tag-along fee 100_000 (sequencer $/${targetID.slice(0,12)}.. requires 90_000)\nchain $/${delegationID}: balance 60_000_000\n`;
 assert.equal(c.withdrawalCosts(withdraw, delegationID).net, '59900000');
 assert.equal(c.withdrawalCosts(withdraw.replace(/using profile.*\n/, `using the minimum tag-along fee 200_000 required by sequencer $/${targetID.slice(0,12)}.. (profile has 100_000)\n`), delegationID).net, '59800000');
 assert.throws(() => c.withdrawalCosts(withdraw + withdraw, delegationID), /ambiguous/);
});
test('delegation prompts accept only single selected IDs and tip address is exact', () => {
 assert.equal(c.delegationPrompt(`authorise sequencer $/${targetID.slice(0,12)}.. to take up to 200_000 out of delegation $/${delegationID.slice(0,12)}..? (Y/n) `).allowance, '200000');
 assert.equal(c.delegationPrompt(`send request to stop delegation $/${delegationID.slice(0,12)}.. to the sequencer $/${targetID}? (Y/n) `).kind, 'stop');
 assert.equal(c.delegationPrompt(`discontinue chain $/${delegationID}? (Y/n) `).id, delegationID);
 assert.equal(c.delegationPrompt('send requests to stop 4 delegations? (Y/n) '), null);
 for (const value of ['all', '--force', 'ab'.repeat(32), delegationID+';']) assert.throws(() => c.chainID(value));
 assert.equal(c.chainID('$/'+delegationID), delegationID);
 assert.equal(c.holder(c.SUPPORT_ADDRESS), '2ca32c1108befd9ff2e84ffa054bb8804c90054320faccc729b9c33b5614eebe');
});
