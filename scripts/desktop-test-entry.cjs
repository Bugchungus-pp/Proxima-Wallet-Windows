'use strict';
// Test-only entry point, excluded from application packaging.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.PROXIMA_TEST_PROFILE;
if (!dir || !path.isAbsolute(dir)) throw new Error('A dedicated test profile is required.');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', dir);
app.setPath('crashDumps', path.join(dir, 'crashes'));
// Only the test entry injects a fake read-only network. It is never packaged.
const monitoring = require('../desktop/monitor.cjs');
const ActualMonitor = monitoring.Monitor;
global.walletTestPolls = 0;
monitoring.Monitor = class extends ActualMonitor {
  constructor({ loadBalance }) {
    super({
      get: async (_origin, route) => {
        global.walletTestPolls++;
        if (route.includes('get_outputs')) return { lrbid: '0001e24001' + 'aa'.repeat(27), outputs: [] };
        return { txid: new URL(route, 'http://test').searchParams.get('txid'), lrbid: '0001e24001' + 'aa'.repeat(27), found_at_depth: 0 };
      },
      loadBalance
    });
  }
};
// Never run the real outbound CLI in tests. Native key verification stays real.
const runner = require('../desktop/process.cjs');
const realRun = runner.run;
const core = require('../desktop/core.cjs');
const d1 = 'd1'.repeat(24), d2 = 'd2'.repeat(24), target = 'e1'.repeat(24);
global.walletTestDelegationSends = 0;
global.walletTestDelegationReceipts = 0;
const balanceReport = `Current slot is 123456
SUMMARY controlled by test:
    on  3 non-chain outputs:            40_000_000
    on  2 delegation outputs:           60_000_000
    on  0 non-delegation chain outputs: 0
TOTAL controlled on 5 outputs: 100_000_000
DELEGATIONS (2):
  $/${d1} 40_000_000 frozen until slot 123999 (90 min from now) maxFrozen: 3
       delegation target $/${target}
  $/${d2} 20_000_000 on hold maxFrozen: 3
       delegation target $/${target}
NO NATIVE TOKENS
NO FOUNDRIES`;
const scanReport = `COMPACTION SCAN of test
    windows evaluated at slot 123456; 5 UTXO(s) indexed under this account
    YOURS, COMPACTABLE   count               tokens
      tagalong-reclaim    1 100_000
      tagalong-cleanup    1 100_000 public
      siglock             1 39_800_000
    YOURS, NOT COMPACTABLE
      on chains           2 60_000_000 delegations
`;

global.walletTestSends = 0;
global.walletTestVerifies = 0;
runner.run = async (executable, args, options) => {
  if (/^wallet-keys(?:\.exe)?$/.test(path.basename(executable))) {
    if (JSON.parse(options.input).action === 'verify') {
      global.walletTestVerifies++;
      if (global.walletTestHoldVerify) await new Promise(resolve => { global.walletTestReleaseVerify = resolve; });
    }
    return realRun(executable, args, options);
  }
  if (!/^proxi(?:\.exe)?$/.test(path.basename(executable)) || args[0] !== 'node') throw new Error('Unexpected test command');
  if (args[1] === 'balance') { if (options.password) throw new Error('Read-only command received password'); return balanceReport; }
  if (args[1] === 'compact' && args[2] === 'scan' && args.includes('--no-public')) {
    if (options.password) throw new Error('Read-only command received password');
    if (global.walletTestScanFailure) throw new Error('Scan unavailable');
    return scanReport;
  }
  if (args[1] === 'delegate' || args[1] === 'killchain') {
    if (!options.password || options.signal.aborted) throw new Error('No active session');
    global.walletTestDelegationSends++;
    if (args[1] === 'delegate') {
      if (args[2] !== 'askstop' || args[3] !== d1) throw new Error('Unexpected delegation command');
      const report = `delegation target ID: $/${target}
delegation $/${d1.slice(0,12)}.. -> $/${target.slice(0,12)}.., unfreezes in slot 123999, balance 40_000_000
   estimated compensation to the sequencer: 300_000
   paid from this wallet (tag-along fee): 100_000
   taken from the delegation (allowance): 200_000
`;
      const allowance = core.delegationPrompt(`authorise sequencer $/${target.slice(0,12)}.. to take up to 200_000 out of delegation $/${d1.slice(0,12)}..? (Y/n) `);
      if (!global.walletTestSkipAllowance && !await options.approve(allowance, report)) return '';
      if (options.signal.aborted) throw new Error('Operation cancelled');
      if (!await options.approve(core.delegationPrompt(`send request to stop delegation $/${d1.slice(0,12)}.. to the sequencer $/${target}? (Y/n) `), report)) return '';
    } else {
      if (args[2] !== d2) throw new Error('Unexpected withdrawal command');
      const report = `using profile tag-along fee 100_000 (sequencer $/${target.slice(0,12)}.. requires 90_000)\nchain $/${d2}: balance 20_000_000\n`;
      if (!await options.approve(core.delegationPrompt(`discontinue chain $/${d2}? (Y/n) `), report)) return '';
    }
    if (options.signal.aborted) throw new Error('Operation cancelled');
    if (global.walletTestDelegationTimeout) throw new Error('Operation timed out');
    global.walletTestDelegationReceipts++;
    return '\n-------- tx OK ' + 'cc'.repeat(31) + global.walletTestDelegationReceipts.toString(16).padStart(2, '0') + ' (len = 200)';
  }
  if (args[1] !== 'send_to_wallet') throw new Error('Unexpected test command');
  if (!options.password) throw new Error('Missing session credential');
  if (options.signal.aborted) throw new Error('Send aborted');
  global.walletTestSends++;
  if (!await options.approve({ kind: 'unknown' }, '')) return '';
  if (!await options.approve({ kind: 'fee', fee: '100000' }, 'ledger: TEST ONLY')) return '';
  if (options.signal.aborted) throw new Error('Send aborted');
  global.walletTestReceipts = (global.walletTestReceipts || 0) + 1;
  const txid = global.walletTestSends.toString(16).padStart(64, '0');
  return 'transaction test submitted successfully\n-------- tx OK ' + txid + ' (len = 100)';
};
require('../desktop/main.cjs');
