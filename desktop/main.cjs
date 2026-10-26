'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, session, powerMonitor } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const QRCode = require('qrcode');
const core = require('./core.cjs');
const { run } = require('./process.cjs');
const { Monitor, closeAgents } = require('./monitor.cjs');
let win, dataDir, busy = false, currentSettings, metadata, history;
let monitor, readFlight = null, closing = false, cachedQR = null, cachedProfile = null;
// Session credential is main-process memory only, never serialized or returned over IPC.
let sessionPassword = null, sessionGeneration = 0, sendController = null;
function clearSession() {
  sessionPassword?.fill(0); sessionPassword = null; sessionGeneration++;
  sendController?.abort(); monitor?.reset();
  if (win && !win.isDestroyed()) win.webContents.send('wallet:locked');
}
function openSession(password, generation) {
  if (generation !== sessionGeneration || closing) throw new Error('Session changed. Unlock the wallet again.');
  sessionPassword?.fill(0); sessionPassword = Buffer.from(password, 'utf8');
}
function requireSession() {
  if (!sessionPassword || closing) throw new Error('Wallet is locked. Unlock it to continue.');
}
const entry = path.resolve(__dirname, '../ui/index.html');
const trustedURL = pathToFileURL(entry).href;
const nativeDir = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.resolve(__dirname, '../bin', process.platform);
const binary = name => path.join(nativeDir, name + (process.platform === 'win32' ? '.exe' : ''));
async function readJSON(name, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw new Error('Cannot read wallet data. Preserve your files and restore from a backup; nothing was overwritten.'); }
}
async function atomic(name, value) {
  const dest = path.join(dataDir, name);
  const tmp = dest + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, dest);
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}
async function store() {
  const ks = await readJSON('proxima.key', null);
  if (!ks || ks.private_key || !ks.crypto || !/^[a-f0-9]{64}$/.test(ks.holder_id)) throw new Error('Create or restore an encrypted wallet first.');
  return ks;
}
async function keys(request) {
  const output = await run(binary('wallet-keys'), [], { cwd: dataDir, input: JSON.stringify(request), timeout: 30000 });
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('Invalid response from keystore engine.'); }
  if (result.error) throw new Error(result.error);
  return result;
}
async function saveNew(ks) {
  // Exclusive creation: an existing wallet can never be silently replaced.
  await fs.writeFile(path.join(dataDir, 'proxima.key'), JSON.stringify(ks, null, 2), { flag: 'wx', mode: 0o600 });
  metadata = { backedUp: false };
  await atomic('metadata.json', metadata);
}
async function ensureEmpty() {
  if (await readJSON('proxima.key', null)) throw new Error('A wallet already exists. This app never overwrites an existing wallet.');
}
async function state() {
  const ks = await readJSON('proxima.key', null);
  if (ks && sessionPassword && !cachedQR) cachedQR = await QRCode.toDataURL('a/' + core.holder(ks.holder_id), { width: 240, margin: 2, errorCorrectionLevel: 'M' });
  // Recheck after asynchronous QR generation: a lock must not return an unlocked snapshot.
  const unlocked = Boolean(sessionPassword);
  if (ks && !unlocked) return { version: app.getVersion(), supportAddress: core.SUPPORT_ADDRESS, exists: true, unlocked: false, holderId: '', backedUp: false, settings: core.DEFAULTS, history: [], qr: null };
  return { version: app.getVersion(), supportAddress: core.SUPPORT_ADDRESS, exists: Boolean(ks), unlocked, holderId: ks?.holder_id || '',
    backedUp: Boolean(metadata.backedUp), settings: currentSettings, history: history.slice(0, 100),
    qr: ks ? cachedQR : null };
}
async function config() {
  const ks = await store();
  // Writing a profile never writes private material or a password.
  const content = core.profile(currentSettings, ks.holder_id);
  if (content !== cachedProfile) {
    await fs.writeFile(path.join(dataDir, 'proxi.yaml'), content, { mode: 0o600 });
    cachedProfile = content;
  }
  return ks;
}
async function confirm(title, message, detail, button = 'Continue') {
  const answer = await dialog.showMessageBox(win, { type: 'warning', title, message, detail,
    buttons: ['Cancel', button], defaultId: 0, cancelId: 0, noLink: true });
  return answer.response === 1;
}
function refresh(force = false) {
  if (closing || busy || !sessionPassword) return Promise.resolve({ skipped: true });
  if (readFlight) return readFlight;
  readFlight = (async () => {
    const ks = await store();
    if (closing || busy || !sessionPassword) return { skipped: true };
    const result = await monitor.poll({ settings: currentSettings, holderId: ks.holder_id, history: history.slice(0, 100), force });
    if (result.cancelled || closing || busy || !sessionPassword) return { skipped: true };
    let changed = false;
    for (const update of result.updates) {
      const item = history.find(h => h.id === update.id && h.txid === update.txid && h.node === result.node);
      if (!item) continue;
      if (item.status !== update.status || item.inclusionDepth !== update.depth) changed = true;
      item.status = update.status; item.inclusionDepth = update.depth;
      item.statusCheckedAt = update.checkedAt; item.statusBranch = update.branch;
    }
    // Persist transitions only; polling timestamps stay in memory to avoid disk churn.
    if (changed) await atomic('history.json', history);
    return { ...result, history: history.slice(0, 100) };
  })().finally(() => { readFlight = null; });
  return readFlight;
}

async function loadWalletBalance(signal) {
  await config();
  if (signal.aborted) throw new Error('Refresh cancelled.');
  const [balanceResult, scanResult] = await Promise.allSettled([
    run(binary('proxi'), ['node', 'balance', '--verbose'], { cwd: dataDir, signal, timeout: 25000 }),
    run(binary('proxi'), ['node', 'compact', 'scan', '--no-public'], { cwd: dataDir, signal, timeout: 25000 })
  ]);
  if (balanceResult.status !== 'fulfilled') throw balanceResult.reason;
  let result = core.balance(balanceResult.value), detailsError = null;
  try { result = core.balanceDetails(balanceResult.value); } catch (err) { detailsError = err.message; }
  try {
    if (scanResult.status !== 'fulfilled') throw scanResult.reason;
    result = { ...result, ...core.spendableScan(scanResult.value) };
  } catch (err) { detailsError = [detailsError, err.message].filter(Boolean).join(' '); }
  return { ...result, detailsError, fetchedAt: new Date().toISOString(), node: currentSettings.nodeUrl };
}
async function delegationAction(value) {
  requireSession();
  const id = core.chainID(value?.id), mode = value?.mode;
  if (!['stop', 'withdraw'].includes(mode)) throw new Error('Choose request unfreeze or withdraw.');
  const generation = sessionGeneration;
  sendController = new AbortController();
  let record = null, authorized = false, cancelled = false, allowanceApproved = null, password = '';
  try {
    const ks = await config();
    const output = await run(binary('proxi'), ['node', 'balance', '--verbose'], { cwd: dataDir, signal: sendController.signal, timeout: 25000 });
    const item = core.balanceDetails(output).delegations.find(d => d.id === id);
    if (!item) throw new Error('This delegation was not found among this wallet’s controlled delegations. Refresh and check the full ID.');
    if (mode === 'stop' && !item.frozen) throw new Error('Delegation is already unlockable. Use Withdraw to wallet instead.');
    if (mode === 'withdraw' && item.frozen) throw new Error('Delegation is still frozen. Wait for the unfreeze slot or request an early stop.');
    if (history.some(h => ['unknown', 'pending', 'submitted', 'included'].includes(h.status) && h.delegationId === id)) {
      if (!await confirm('Check earlier delegation action', 'An earlier action on this delegation may still be pending.', 'Check Activity and the node before submitting another request. Do not pay twice for the same early stop.', 'I have checked')) return { cancelled: true };
    }
    requireSession();
    if (generation !== sessionGeneration) throw new Error('Wallet session changed.');
    record = { id: randomUUID(), date: new Date().toISOString(), kind: 'delegation-' + mode, delegationId: id, recipient: ks.holder_id, motes: item.motes, node: currentSettings.nodeUrl, status: 'pending', txid: null };
    history.unshift(record); await atomic('history.json', history);
    requireSession();
    if (generation !== sessionGeneration) throw new Error('Wallet session changed.');
    password = sessionPassword.toString('utf8');
    const args = mode === 'stop' ? ['node', 'delegate', 'askstop', id, '--verbose'] : ['node', 'killchain', id, '--nowait', '--verbose'];
    const report = await run(binary('proxi'), args, {
      cwd: dataDir, password, signal: sendController.signal, timeout: 240000,
      parsePrompt: core.delegationPrompt,
      promptOrder: mode === 'stop' ? ['allowance', 'stop'] : ['withdraw'],
      // askstop ignores --nowait upstream. Stop its read-only inclusion watcher
      // only AFTER SubmitAndDisplay's successful receipt; never retry submission.
      stopOnReceipt: core.submissionReceipt,
      approve: async (p, report) => {
        if (!sessionPassword || generation !== sessionGeneration) return false;
        const cost = mode === 'stop' ? core.stopCosts(report, id) : core.withdrawalCosts(report, id);
        if (mode === 'stop') {
          if (!item.target || cost.target !== item.target || p.idShort !== '$/' + id.slice(0, 12) + '..') throw new Error('Delegation target or ID changed. Refresh before retrying.');
          if (p.kind === 'allowance' && (p.allowance !== cost.allowance || p.targetShort !== '$/' + cost.target.slice(0, 12) + '..')) throw new Error('Allowance confirmation mismatch.');
          if (p.kind === 'stop' && (p.target !== cost.target || (cost.allowance !== '0' && allowanceApproved !== cost.allowance))) throw new Error('Missing allowance authorization.');
        } else if (p.kind !== 'withdraw' || p.id !== id) throw new Error('Withdrawal confirmation mismatch.');
        const detail = 'Delegation: $/' + id + '\n\n' + (mode === 'stop'
          ? 'Target sequencer: $/' + cost.target + '\nTag-along fee from spendable wallet funds: ' + core.fromMotes(cost.fee) + ' PROX\nMaximum compensation from delegation: ' + core.fromMotes(cost.allowance) + ' PROX\nTotal maximum cost: ' + core.fromMotes(cost.compensation) + ' PROX\n\nThis is a request, not instant unfreezing. The target must process it. Refresh the delegation state before withdrawing.'
          : 'Delegation balance: ' + core.fromMotes(cost.motes) + ' PROX\nTag-along fee deducted: ' + core.fromMotes(cost.fee) + ' PROX\nReturn to your wallet: ' + core.fromMotes(cost.net) + ' PROX\nAddress: a/' + ks.holder_id + '\n\nThis permanently ends the selected delegation chain and returns its funds minus the fee. It cannot be undone.')
          + '\n\nNode: ' + currentSettings.nodeUrl;
        const yes = await confirm(p.kind === 'allowance' ? 'Approve early-stop compensation' : mode === 'stop' ? 'Request delegation unfreeze' : 'Withdraw delegation to wallet', p.kind === 'allowance' ? 'Authorize this maximum deduction from the delegation?' : 'Review the exact operation before signing.', detail, p.kind === 'allowance' ? 'Authorize compensation' : 'Sign and submit');
        if (!yes || generation !== sessionGeneration) { cancelled = true; return false; }
        if (p.kind === 'allowance') allowanceApproved = cost.allowance;
        else {
          authorized = true; record.fee = cost.fee; record.allowance = cost.allowance;
          record.motes = mode === 'stop' ? cost.compensation : cost.motes;
          await atomic('history.json', history);
        }
        return generation === sessionGeneration && Boolean(sessionPassword);
      }
    });
    record.txid = core.submissionReceipt(report);
    record.status = cancelled ? 'cancelled' : authorized && record.txid ? 'submitted' : authorized ? 'unknown' : 'failed';
    await atomic('history.json', history);
    if (!cancelled && record.status !== 'submitted') throw new Error('No verified submission receipt. Refresh the delegation before retrying.');
    return { cancelled, record };
  } catch (err) {
    if (record) { record.status = authorized ? 'unknown' : cancelled ? 'cancelled' : 'failed'; await atomic('history.json', history); }
    throw new Error((authorized ? 'Submission outcome uncertain. Check Activity and the node before retrying.\n' : '') + err.message);
  } finally { password = ''; sendController = null; monitor.reset(); }
}

const actions = {
  state,
  async unlock(value) {
    if (sessionPassword) return state();
    const generation = sessionGeneration;
    let password = core.password(value?.password);
    try {
      await keys({ action: 'verify', password, keystore: await store() });
      openSession(password, generation);
      return state();
    } finally { password = ''; if (value) value.password = ''; }
  },
  async lock() { clearSession(); return state(); },
  async create(value) {
    await ensureEmpty();
    if (value?.acknowledged !== true) throw new Error('Acknowledge the pre-launch risks.');
    const generation = sessionGeneration;
    const password = core.password(value.password, true);
    const result = await keys({ action: 'create', newPassword: password });
    await saveNew(result.keystore);
    openSession(password, generation);
    return state();
  },
  async import(value) {
    await ensureEmpty();
    if (value?.acknowledged !== true) throw new Error('Acknowledge the pre-launch risks.');
    const generation = sessionGeneration;
    const newPassword = core.password(value.newPassword, true);
    const oldPassword = core.text(value.password || '', 1024);
    const selected = await dialog.showOpenDialog(win, { title: 'Import a Proxima wallet file', properties: ['openFile'], filters: [{ name: 'Proxima wallet files', extensions: ['key', 'json', 'txt'] }, { name: 'Text files', extensions: ['txt'] }] });
    if (selected.canceled) return null;
    // Bound the read itself, not just a preceding stat. File contents never go to IPC.
    const handle = await fs.open(selected.filePaths[0], 'r');
    const buffer = Buffer.alloc(16385);
    let result;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Select a regular wallet file.');
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 16384) throw new Error('Wallet file is too large (maximum 16 KiB).');
      if (!length) throw new Error('Wallet file is empty.');
      result = await keys({ action: 'import', password: oldPassword, newPassword, importData: buffer.subarray(0, length).toString('base64') });
    } finally { buffer.fill(0); await handle.close(); }
    if (!await confirm('Confirm imported wallet', 'Compare the recovered address with your existing wallet.',
      'Recovered address: a/' + result.holderId + '\n\nOnly continue if this is the wallet you intended to restore. The imported key will be encrypted with your new password. The original file is not modified or deleted; if it contains a plaintext key, keep it private.', 'Import this wallet')) return null;
    await saveNew(result.keystore);
    openSession(newPassword, generation);
    return state();
  },
  async backup() {
    // Export ciphertext only: copying an encrypted store does not require unlocking it.
    const ks = await store();
    const selected = await dialog.showSaveDialog(win, { title: 'Save encrypted wallet backup', defaultPath: 'Proxima-' + ks.holder_id.slice(0, 8) + '.key', filters: [{ name: 'Encrypted Proxima keystore', extensions: ['key'] }] });
    if (selected.canceled) return null;
    const target = path.resolve(selected.filePath);
    const relative = path.relative(dataDir, target);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Save the backup outside the application data folder, preferably on an offline drive.');
    const encoded = JSON.stringify(ks, null, 2);
    await fs.writeFile(target, encoded, { mode: 0o600 });
    if (await fs.readFile(target, 'utf8') !== encoded) throw new Error('Backup verification failed.');
    metadata = { ...metadata, backedUp: true };
    await atomic('metadata.json', metadata);
    return state();
  },
  balance: () => refresh(true),
  sync: () => refresh(false),
  async send(value) {
    requireSession();
    const generation = sessionGeneration;
    await config();
    const recipient = core.holder(value?.recipient);
    const motes = core.sendAmount(value?.amount);
    if (history.some(h => ['unknown', 'pending'].includes(h.status))) {
      if (!await confirm('Check previous transfer', 'An earlier transfer has an uncertain outcome.', 'Check its recipient and the node before sending again. Retrying can cause a duplicate payment. Have you checked?', 'I have checked')) return { cancelled: true };
    }
    requireSession();
    if (generation !== sessionGeneration) throw new Error('Wallet session changed.');
    const record = { id: randomUUID(), date: new Date().toISOString(), recipient, motes, node: currentSettings.nodeUrl, status: 'pending', txid: null };
    history.unshift(record);
    await atomic('history.json', history);
    let authorized = false, cancelled = false;
    sendController = new AbortController();
    let password = '';
    try {
      requireSession();
      if (generation !== sessionGeneration) throw new Error('Wallet session changed.');
      password = sessionPassword.toString('utf8');
      const output = await run(binary('proxi'), ['node', 'send_to_wallet', motes, recipient, '--nowait', '--verbose'], {
        cwd: dataDir, password, signal: sendController.signal, timeout: 240000,
        approve: async (p, report) => {
          if (!sessionPassword || generation !== sessionGeneration) return false;
          if (p.kind === 'unknown') {
            const yes = await confirm('Unknown recipient', 'This holder ID is not yet known on the ledger.', 'An incorrect address can permanently lose tokens. Check the full ID with the recipient:\n\na/' + recipient, 'Address is correct');
            if (!yes || generation !== sessionGeneration) { cancelled = true; return false; }
            return yes;
          }
          const fee = BigInt(p.fee);
          if (BigInt(motes) + fee > core.MAX) throw new Error('Amount plus fee exceeds the supported range.');
          const ledger = report.match(/^ledger: (.+)$/m)?.[1] || 'Ledger description unavailable — cancel if unexpected';
          const yes = await confirm('Approve Proxima transfer', 'Review the exact transfer before signing.',
            'Send: ' + core.fromMotes(motes) + ' PROX\nFee: ' + core.fromMotes(p.fee) + ' PROX (' + p.fee + ' motes)\nTotal: ' + core.fromMotes((BigInt(motes) + fee).toString()) + ' PROX\n\nTo: a/' + recipient + '\n\nNode: ' + currentSettings.nodeUrl + '\nLedger: ' + ledger + '\n\nPre-launch network. Submission is not confirmation.', 'Sign and submit');
          if (generation !== sessionGeneration) { cancelled = true; return false; }
          authorized = yes;
          if (!yes) cancelled = true;
          if (yes) { record.fee = p.fee; await atomic('history.json', history); }
          return yes;
        }
      });
      record.txid = core.receipt(output);
      if (cancelled) record.status = 'cancelled';
      else if (authorized && record.txid) record.status = 'submitted';
      else { record.status = authorized ? 'unknown' : 'failed'; throw new Error('No verified submission receipt. Check the node before retrying.'); }
      await atomic('history.json', history);
      monitor.reset();
      return { cancelled, record, report: output };
    } catch (err) {
      record.status = authorized ? 'unknown' : 'failed';
      await atomic('history.json', history);
      throw new Error((authorized ? 'Submission outcome uncertain. Check the node before retrying.\n\n' : '') + err.message);
    } finally {
      // Drop the per-child string; the session buffer remains until lock/close.
      // JS/OS copies cannot be reliably zeroized.
      password = '';
      sendController = null;
    }
  },
  delegation: delegationAction,
  async copySupport() { clipboard.writeText(core.SUPPORT_ADDRESS); return core.SUPPORT_ADDRESS; },
  async settings(value) {
    const next = core.settings(value);
    if (!await confirm('Change network settings', 'Use only Proxima nodes you trust.', 'Node: ' + next.nodeUrl + '\nWitnesses: ' + next.witnesses.join(', ') + '\n\nHTTP is not encrypted. Witness checks reduce single-node risk but do not replace a trusted network. Changing nodes does not move or restore funds.', 'Save settings')) return null;
    await atomic('settings.json', next);
    currentSettings = next;
    cachedProfile = null; monitor.reset();
    return state();
  },
  async copyAddress() {
    clipboard.writeText('a/' + (await store()).holder_id);
    return true;
  },
  async docs() { await shell.openExternal('https://lunfardo314.github.io/#/participate/participate'); return true; }
};
function register() {
  for (const [name, action] of Object.entries(actions)) {
    ipcMain.handle('wallet:' + name, async (event, value) => {
      if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== trustedURL) return { ok: false, error: 'Untrusted window.' };
      const exclusive = !['state', 'copyAddress', 'docs', 'balance', 'sync'].includes(name);
      if (exclusive && busy) return { ok: false, error: 'Another operation is running. Please wait.' };
      if (exclusive) busy = true;
      try {
        if (!['state', 'unlock', 'lock', 'create', 'import', 'docs'].includes(name)) requireSession();
        if (exclusive && readFlight) {
          monitor.cancel();
          await readFlight.catch(() => {});
        }
        if (!['state', 'unlock', 'lock', 'create', 'import', 'docs'].includes(name)) requireSession();
        return { ok: true, value: await action(value) };
      }
      catch (err) { return { ok: false, error: String(err.message).slice(0, 16000) }; }
      finally {
        if (value && typeof value === 'object') { if ('password' in value) value.password = ''; if ('newPassword' in value) value.newPassword = ''; }
        if (exclusive) busy = false;
      }
    });
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    dataDir = app.getPath('userData');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    currentSettings = core.settings(await readJSON('settings.json', core.DEFAULTS));
    metadata = await readJSON('metadata.json', { backedUp: false });
    history = await readJSON('history.json', []);
    if (!Array.isArray(history)) throw new Error('Invalid transfer history. Preserve wallet files.');
    for (const h of history) if (h.status === 'pending') h.status = 'unknown';
    await atomic('history.json', history);
    monitor = new Monitor({ loadBalance: loadWalletBalance });
    session.defaultSession.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('data:image/png;base64,') });
    });
    win = new BrowserWindow({ width: 1220, height: 850, minWidth: 920, minHeight: 680,
      backgroundColor: '#f5f5f2', title: 'Proxima Wallet', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged, spellcheck: false }
    });
    powerMonitor.on('lock-screen', clearSession);
    powerMonitor.on('suspend', clearSession);
    win.webContents.on('render-process-gone', clearSession);
    win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) clearSession(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => {
      if (busy) { event.preventDefault(); dialog.showMessageBoxSync(win, { type: 'info', message: 'An operation is running. Cancel its confirmation or wait for it to finish before closing.' }); }
    });
    win.on('closed', () => { closing = true; clearSession(); closeAgents(); });
    app.on('before-quit', () => { if (!busy) { closing = true; clearSession(); closeAgents(); } });
    register();
    await win.loadFile(entry);
  }).catch(err => { dialog.showErrorBox('Cannot open wallet', err.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
