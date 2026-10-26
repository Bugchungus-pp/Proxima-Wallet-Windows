'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
 await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
 const dir = await fs.mkdtemp(path.join(root, 'test-results', 'desktop-'));
 const backup = path.join(dir, 'saved-backup.key');
 const pass = 'disposable test passphrase';
 let app;
 const launch = async profile => {
  const headlessFlags = process.env.PROXIMA_HEADLESS_TEST === '1' ? ['--ozone-platform=headless', '--no-sandbox'] : [];
  app = await electron.launch({ args: [...headlessFlags, path.join(__dirname, 'desktop-test-entry.cjs')], env: { ...process.env, PROXIMA_TEST_PROFILE: path.join(dir, profile) } });
  const page = await app.firstWindow(); await page.waitForSelector('[data-setup=create]', { state: 'attached' });
  await page.waitForFunction(() => Boolean(window.wallet));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  return page;
 };
 // Real password verification, with no signing/network/funded transfers.
 const checkSendWithoutBackup = async (page, password, wrongPassword) => {
  assert.equal((await page.evaluate(() => window.wallet.state())).backedUp, false);
  await app.evaluate(({ dialog }) => {
   global.walletTestDialogs = [];
   dialog.showOpenDialog = async () => { throw new Error('Send must not open a key file'); };
   dialog.showSaveDialog = async () => { throw new Error('Send must not export a backup'); };
   dialog.showMessageBox = async (_win, options) => {
    global.walletTestDialogs.push(options);
    return { response: options.title === 'Approve Proxima transfer' ? 0 : 1 };
   };
  });
  // Creation/import already opens a session; lock to test authentication boundaries.
  assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, true);
  await page.evaluate(() => window.wallet.lock());
  const locked = await page.evaluate(() => window.wallet.state());
  assert.equal(locked.unlocked, false); assert.equal(locked.holderId, ''); assert.deepEqual(locked.history, []);
  for (const method of ['send', 'backup', 'sync', 'balance', 'copyAddress', 'settings', 'delegation', 'copySupport']) {
   const message = await page.evaluate(async method => {
    try { await window.wallet[method]({ recipient: 'ab'.repeat(32), amount: '10' }); return ''; }
    catch (e) { return e.message; }
   }, method);
   assert.match(message, /locked/i);
  }
  for (const invalid of ['', wrongPassword]) {
   const message = await page.evaluate(async password => {
    try { await window.wallet.unlock({ password }); return ''; }
    catch (error) { return error.message; }
   }, invalid);
   assert.match(message, /password|decrypt|authentication/i);
   assert.equal(await app.evaluate(() => global.walletTestSends), 0, 'Invalid password reached outbound CLI');
   assert.equal(await app.evaluate(() => global.walletTestDialogs.length), 0);
  }
  await page.locator('#unlock-password').fill(password);
  await page.locator('#unlock-submit').click();
  await page.waitForSelector('#unlock-screen', { state: 'hidden' });
  assert.equal(await page.locator('#unlock-password').inputValue(), '');
  assert.equal(await page.locator('#send-form input[type=password]').count(), 0);
  const verifiedAtUnlock = await app.evaluate(() => global.walletTestVerifies);
  const cancelled = await page.evaluate(() => window.wallet.send({ recipient: 'ab'.repeat(32), amount: '10' }));
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.record.status, 'cancelled');
  await app.evaluate(({ dialog }) => {
   dialog.showMessageBox = async (_win, options) => { global.walletTestDialogs.push(options); return { response: 1 }; };
  });
  const result = await page.evaluate(() => window.wallet.send({ recipient: 'ab'.repeat(32), amount: '10' }));
  assert.equal(await app.evaluate(() => global.walletTestVerifies), verifiedAtUnlock, 'Send must reuse the session without another password verification');
  assert.equal(result.record.status, 'submitted');
  assert.equal(result.record.fee, '100000');
  assert.match(result.record.txid, /^[a-f0-9]{64}$/);
  const dialogs = await app.evaluate(() => global.walletTestDialogs);
  assert.deepEqual(dialogs.map(d => d.title), ['Unknown recipient', 'Approve Proxima transfer', 'Unknown recipient', 'Approve Proxima transfer']);
  assert.match(dialogs[3].detail, /Send: 10.000000 PROX\nFee: 0.100000 PROX/);
  assert.match(dialogs[3].detail, /Total: 10.100000 PROX/);
  assert.ok(dialogs[3].detail.includes('To: a/' + 'ab'.repeat(32)));
  assert.equal((await page.evaluate(() => window.wallet.state())).backedUp, false);
 };
 try {
  let page = await launch('first');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  assert.equal(await page.locator('#browser-warning').isVisible(), false);
  await page.locator('[data-setup=create]').click();
  await page.locator('#new-password').fill(pass); await page.locator('#confirm-password').fill(pass); await page.locator('#risk-check').check();
  await page.locator('#setup-submit').click(); await page.waitForSelector('#wallet-overview:not([hidden])');
  const initial = await page.evaluate(() => window.wallet.state());
  assert.match(initial.holderId, /^[a-f0-9]{64}$/); assert.equal(initial.backedUp, false);
  const ks = JSON.parse(await fs.readFile(path.join(dir, 'first', 'proxima.key')));
  assert.equal(ks.private_key, undefined); assert.ok(ks.crypto);
  assert.equal(await page.locator('#new-password').inputValue(), '');
  await checkSendWithoutBackup(page, pass, 'incorrect password');
  const verifiesBeforeBackup = await app.evaluate(() => global.walletTestVerifies);
  assert.equal(await page.locator('#backup-form input[type=password]').count(), 0);
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  assert.equal(await page.evaluate(() => window.wallet.backup()), null);
  assert.equal((await page.evaluate(() => window.wallet.state())).backedUp, false);
  await app.evaluate(({ dialog }, backup) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: backup }); }, backup);
  await page.locator('.nav-item[data-view=security]').click();
  await page.locator('#backup-form button').click(); await page.waitForFunction(() => document.getElementById('backup-state').textContent.includes('copy saved'));
  assert.deepEqual(JSON.parse(await fs.readFile(backup)), ks);
  assert.equal(await app.evaluate(() => global.walletTestVerifies), verifiesBeforeBackup, 'Encrypted export must not decrypt or verify a password');
  await page.locator('.nav-item[data-view=send]').click();
  await page.locator('#recipient').fill('ab'.repeat(32));
  await page.locator('#amount').fill('10');
  assert.equal(await page.locator('#send-password').count(), 0);
  const beforePolls = await app.evaluate(() => global.walletTestPolls);
  await page.waitForTimeout(3400);
  assert.ok(await app.evaluate(() => global.walletTestPolls) > beforePolls, '3-second refresh did not execute');
  assert.equal(await page.locator('#recipient').inputValue(), 'ab'.repeat(32));
  assert.equal(await page.locator('#amount').inputValue(), '10');
  assert.match(await page.locator('#send-minimum-note').innerText(), /10 PROX.*0.1 PROX/);
  const tooSmall = await page.evaluate(async () => {
    try { await window.wallet.send({ recipient: 'ab'.repeat(32), amount: '9.999999' }); return ''; }
    catch (e) { return e.message; }
  });
  assert.match(tooSmall, /Minimum send/);
  await page.locator('.nav-item[data-view=receive]').click();
  assert.equal(await page.locator('#qr').isVisible(), true);
  await page.waitForFunction(() => document.getElementById('receive-balance').textContent === '100.000000');
  assert.equal(await page.locator('#receive-pending').textContent(), '0');
  assert.equal(await page.locator('#receive-lrb-slot').textContent(), '123,456');
  assert.equal(await page.locator('#overview-lrb-slot').textContent(), '123,456');
  await page.locator('.nav-item[data-view=overview]').click();
  await page.screenshot({ path: path.join(root, 'artifacts', 'wallet-dashboard.png'), fullPage: true });
  await page.locator('.nav-item[data-view=receive]').click();
  assert.equal(await page.locator('#full-address').textContent(), 'a/' + initial.holderId);
  await page.locator('[data-page=receive] [data-copy]').click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText()); assert.equal(copied, 'a/' + initial.holderId);
  // PC lock/sleep and renderer reload revoke the in-memory credential.
  for (const reason of ['lock-screen', 'suspend', 'reload']) {
   if (reason === 'reload') await page.reload();
   else await app.evaluate(({ powerMonitor }, event) => powerMonitor.emit(event), reason);
   await page.waitForSelector('#unlock-screen:not([hidden])');
   assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, false);
   const before = await app.evaluate(() => global.walletTestPolls);
   await page.waitForTimeout(3100);
   assert.equal(await app.evaluate(() => global.walletTestPolls), before, 'Locked wallet must not keep polling');
   await page.locator('#unlock-password').fill(pass);
   await page.locator('#unlock-submit').click();
   await page.waitForSelector('#unlock-screen', { state: 'hidden' });
  }
  // An OS lock during fee confirmation must not accept a late Yes response.
  const receiptsBeforeLock = await app.evaluate(() => global.walletTestReceipts);
  await app.evaluate(({ dialog, powerMonitor }) => {
   dialog.showMessageBox = async (_win, options) => {
    if (options.title === 'Approve Proxima transfer') powerMonitor.emit('lock-screen');
    return { response: 1 };
   };
  });
  const duringLock = await page.evaluate(async () => {
   try { return await window.wallet.send({ recipient: 'ab'.repeat(32), amount: '10' }); }
   catch (e) { return { error: e.message }; }
  });
  assert.ok(duringLock.cancelled || duringLock.error);
  assert.equal(await app.evaluate(() => global.walletTestReceipts), receiptsBeforeLock);
  assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, false);
  // A lock while native verification is pending cannot reopen the session later.
  await app.evaluate(() => { global.walletTestHoldVerify = true; });
  await page.evaluate(password => {
   window.testUnlockResult = window.wallet.unlock({ password }).then(() => 'unexpected success', error => error.message);
  }, pass);
  for (let i = 0; i < 100 && !await app.evaluate(() => Boolean(global.walletTestReleaseVerify)); i++) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => Boolean(global.walletTestReleaseVerify)), true);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); global.walletTestHoldVerify = false; global.walletTestReleaseVerify(); });
  assert.match(await page.evaluate(() => window.testUnlockResult), /Session changed/);
  assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, false);
  await page.locator('#unlock-password').fill(pass);
  await page.locator('#unlock-submit').click();
  await page.waitForSelector('#unlock-screen', { state: 'hidden' });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.locator('.nav-item[data-view=send]').click();
  await page.locator('#recipient').fill('ab'.repeat(32)); await page.locator('#amount').fill('10');
  await page.locator('#send-form button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('notification').textContent.includes('Transaction submitted'));
  assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, true);
  for (const name of ['proxima.key', 'metadata.json', 'history.json', 'proxi.yaml']) {
   assert.equal((await fs.readFile(path.join(dir, 'first', name), 'utf8')).includes(pass), false, 'Password persisted to ' + name);
  }
  assert.equal(JSON.stringify(await page.evaluate(() => window.wallet.state())).includes(pass), false);
  // Fund cards use production parsers and the support button only prefills a transfer.
  await page.locator('.nav-item[data-view=overview]').click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.getElementById('spendable-balance').textContent === '39.800000');
  assert.equal(await page.locator('#delegated-balance').textContent(), '60.000000');
  assert.equal(await page.locator('#tagalong-balance').textContent(), '0.200000');
  const support = 'a/2ca32c1108befd9ff2e84ffa054bb8804c90054320faccc729b9c33b5614eebe';
  assert.equal(await page.locator('#support-address').textContent(), support);
  await page.locator('#support-copy').click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), support);
  const sendsBeforeTip = await app.evaluate(() => global.walletTestSends);
  await page.locator('#support-tip').click();
  assert.equal(await page.locator('#recipient').inputValue(), support);
  assert.equal(await page.locator('#amount').inputValue(), '');
  assert.equal(await app.evaluate(() => global.walletTestSends), sendsBeforeTip);
  const delegate = async (id, mode) => page.evaluate(async value => {
   try { return await window.wallet.delegation(value); } catch(e) { return { error: e.message }; }
  }, { id, mode });
  assert.match((await delegate('d1'.repeat(24), 'withdraw')).error, /still frozen/);
  assert.match((await delegate('d2'.repeat(24), 'stop')).error, /already unlockable/);
  assert.match((await delegate('aa'.repeat(24), 'withdraw')).error, /not found/);
  assert.match((await delegate('--force', 'stop')).error, /delegation ID/);
  assert.equal(await app.evaluate(() => global.walletTestDelegationSends), 0);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  assert.equal((await delegate('d1'.repeat(24), 'stop')).cancelled, true);
  assert.equal(await app.evaluate(() => global.walletTestDelegationReceipts), 0);
  await app.evaluate(({ dialog }) => {
   global.walletTestDelegationDialogs = [];
   dialog.showMessageBox = async (_win, options) => { global.walletTestDelegationDialogs.push(options); return { response: 1 }; };
   global.walletTestSkipAllowance = true;
  });
  assert.match((await delegate('d1'.repeat(24), 'stop')).error, /Missing allowance/);
  await app.evaluate(() => { global.walletTestSkipAllowance = false; });
  await page.locator('.nav-item[data-view=delegations]').click();
  await page.locator('#refresh').click();
  await page.waitForSelector('[data-delegation-id="' + 'd1'.repeat(24) + '"]:not([disabled])');
  await page.screenshot({ path: path.join(root, 'artifacts', 'wallet-delegations.png'), fullPage: true });
  await page.locator('[data-delegation-id="' + 'd1'.repeat(24) + '"]').click();
  await page.waitForFunction(() => document.getElementById('notification').textContent.includes('Unfreeze request submitted'));
  let last = (await page.evaluate(() => window.wallet.state())).history[0];
  assert.equal(last.kind, 'delegation-stop'); assert.ok(['submitted', 'included'].includes(last.status)); assert.equal(last.fee, '100000'); assert.equal(last.allowance, '200000');
  const dialogs = await app.evaluate(() => global.walletTestDelegationDialogs);
  assert.deepEqual(dialogs.map(d => d.title), ['Approve early-stop compensation', 'Request delegation unfreeze']);
  assert.ok(dialogs[1].detail.includes('0.100000 PROX'));
  assert.ok(dialogs[1].detail.includes('0.200000 PROX'));
  assert.ok(dialogs[1].detail.includes('0.300000 PROX'));
  assert.ok(dialogs[1].detail.includes('d1'.repeat(24)));
  await page.waitForSelector('[data-delegation-id="' + 'd2'.repeat(24) + '"]:not([disabled])');
  await page.locator('[data-delegation-id="' + 'd2'.repeat(24) + '"]').click();
  await page.waitForFunction(() => document.getElementById('notification').textContent.includes('Withdrawal submitted'));
  last = (await page.evaluate(() => window.wallet.state())).history[0];
  assert.equal(last.kind, 'delegation-withdraw'); assert.ok(['submitted', 'included'].includes(last.status));
  assert.ok((await app.evaluate(() => global.walletTestDelegationDialogs.at(-1).detail)).includes('19.900000 PROX'));
  await app.evaluate(() => { global.walletTestDelegationTimeout = true; });
  assert.match((await delegate('d2'.repeat(24), 'withdraw')).error, /uncertain/);
  assert.equal((await page.evaluate(() => window.wallet.state())).history[0].status, 'unknown');
  await app.evaluate(() => { global.walletTestDelegationTimeout = false; global.walletTestScanFailure = true; });
  const degraded = await page.evaluate(() => window.wallet.balance());
  assert.equal(degraded.balance.motes, '100000000'); assert.equal(degraded.balance.spendableMotes, undefined);
  assert.match(degraded.balance.detailsError, /Scan unavailable/);
  await app.evaluate(() => { global.walletTestScanFailure = false; });
  // Revoking the session while authorizing compensation cannot sign a request.
  const beforeDelegationLock = await app.evaluate(() => global.walletTestDelegationReceipts);
  await app.evaluate(({ dialog, powerMonitor }) => {
   dialog.showMessageBox = async (_win, options) => {
    if (options.title === 'Approve early-stop compensation') powerMonitor.emit('lock-screen');
    return { response: 1 };
   };
  });
  const lockedDelegation = await delegate('d1'.repeat(24), 'stop');
  assert.ok(lockedDelegation.cancelled || lockedDelegation.error);
  assert.equal(await app.evaluate(() => global.walletTestDelegationReceipts), beforeDelegationLock);
  assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, false);
  await page.locator('#unlock-password').fill(pass); await page.locator('#unlock-submit').click();
  await page.waitForSelector('#unlock-screen', { state: 'hidden' });


  await page.locator('#lock-wallet').click();
  await page.waitForSelector('#unlock-screen:not([hidden])');
  await page.screenshot({ path: path.join(root, 'artifacts', 'wallet-unlock.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await app.close(); app = null;
  page = await launch('second');
  await app.evaluate(({ dialog }, backup) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backup] }); }, backup);
  await page.locator('[data-setup=import]').click();
  await page.locator('#old-password').fill(pass); await page.locator('#new-password').fill('new disposable passphrase'); await page.locator('#confirm-password').fill('new disposable passphrase'); await page.locator('#risk-check').check();
  await page.locator('#setup-submit').click(); await page.waitForSelector('#wallet-overview:not([hidden])');
  const restored = await page.evaluate(() => window.wallet.state());
  assert.equal(restored.holderId, initial.holderId); assert.equal(restored.backedUp, false);
  await checkSendWithoutBackup(page, 'new disposable passphrase', pass);
  const duplicate = await page.evaluate(async () => { try { await window.wallet.create({ password: 'should not replace', acknowledged: true }); return ''; } catch (e) { return e.message; } });
  assert.match(duplicate, /already exists/);
  await app.close(); app = null;
  // A crashed transfer must restart as uncertain, never as confirmed or retried.
  await fs.writeFile(path.join(dir, 'second', 'history.json'), JSON.stringify([{ id: 'test', date: new Date().toISOString(), recipient: 'ab'.repeat(32), motes: '1', status: 'pending' }]));
  page = await launch('second');
  await page.waitForSelector('#unlock-screen:not([hidden])');
  assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, false);
  await page.locator('#unlock-password').fill('wrong password');
  await page.locator('#unlock-submit').click();
  await page.waitForSelector('#unlock-error:not([hidden])');
  assert.equal((await page.evaluate(() => window.wallet.state())).unlocked, false);
  await page.locator('#unlock-password').fill('new disposable passphrase');
  await page.locator('#unlock-submit').click();
  await page.waitForSelector('#unlock-screen', { state: 'hidden' });
  const restarted = await page.evaluate(() => window.wallet.state());
  assert.equal(restarted.history[0].status, 'unknown');
  await app.close(); app = null;
  // Notepad-style encrypted JSON renamed to TXT, with UTF-16 BOM.
  const textBackup = path.join(dir, 'notepad-wallet.txt');
  await fs.writeFile(textBackup, Buffer.from('\ufeff' + JSON.stringify(ks, null, 2) + '\r\n', 'utf16le'));
  page = await launch('txt-json');
  await app.evaluate(({ dialog }, file) => {
   dialog.showOpenDialog = async (_win, options) => {
    if (!options.filters.some(f => f.extensions.includes('txt'))) throw new Error('TXT filter missing');
    return { canceled: false, filePaths: [file] };
   };
  }, textBackup);
  const txtResult = await page.evaluate(async pass => window.wallet.import({ password: pass, newPassword: 'new encrypted TXT password', acknowledged: true }), pass);
  assert.equal(txtResult.holderId, initial.holderId);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'txt-json', 'proxima.key'))).private_key, undefined);
  await app.close(); app = null;
  // Plaintext key fixture, generated for testing only, never a real funded wallet.
  const crypto = require('node:crypto');
  const pair = crypto.generateKeyPairSync('ed25519');
  const seed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyHex = Buffer.concat([seed, pub]).toString('hex');
  const plainFile = path.join(dir, 'private-wallet.txt');
  await fs.writeFile(plainFile, 'private_key: ' + keyHex + '\r\n');
  page = await launch('txt-plain');
  await app.evaluate(({ dialog }, file) => {
   dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
   dialog.showMessageBox = async () => ({ response: 0 });
  }, plainFile);
  const cancelled = await page.evaluate(() => window.wallet.import({ password: '', newPassword: 'new plaintext import password', acknowledged: true }));
  assert.equal(cancelled, null);
  assert.equal((await page.evaluate(() => window.wallet.state())).exists, false);
  await assert.rejects(fs.access(path.join(dir, 'txt-plain', 'proxima.key')));
  await app.evaluate(({ dialog }, secret) => {
   dialog.showMessageBox = async (_win, options) => {
    if (options.detail.includes(secret)) throw new Error('Private key displayed in confirmation');
    if (!options.detail.includes('Recovered address: a/')) throw new Error('Address confirmation missing');
    return { response: 1 };
   };
  }, keyHex);
  const plainResult = await page.evaluate(() => window.wallet.import({ password: '', newPassword: 'new plaintext import password', acknowledged: true }));
  const saved = await fs.readFile(path.join(dir, 'txt-plain', 'proxima.key'), 'utf8');
  await checkSendWithoutBackup(page, 'new plaintext import password', 'incorrect password');
  assert.equal(JSON.parse(saved).public_key, pub.toString('hex'));
  assert.equal(saved.includes(keyHex), false);
  assert.equal(JSON.stringify(plainResult).includes(keyHex), false);
  assert.equal((await page.content()).includes(keyHex), false);
  assert.equal(await fs.readFile(plainFile, 'utf8'), 'private_key: ' + keyHex + '\r\n');
  console.log('Desktop smoke passed: spendable/delegated/tag-along balances, unfreeze/withdraw approvals and cancellations, lock/timeout guards, optional tip copy/prefill, startup unlock, session-only sends, lock/sleep/reload/restart guards, LRB slots, no-backup sending after create/encrypted/plaintext import, invalid password rejection, native approvals/cancellation, ciphertext-only backup, create/backup/TXT restore, cancellation, 3-second refresh with mock network, typing preserved, minimum-send guard, Receive details, clipboard and crash recovery. No live transfers.');
 } finally { if (app) await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
