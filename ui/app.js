'use strict';
const $ = id => document.getElementById(id);
const api = window.wallet;
if (api) document.body.classList.add('awaiting-state');
let state = { exists: false, unlocked: false, backedUp: false, history: [], settings: { nodeUrl: 'http://65.21.170.230:8001', witnesses: ['http://79.137.70.25:8001', 'http://51.254.47.76:8001'], sequencer: 'random' } };
let busy = false, setupMode = 'create';
let syncTimer = null, syncFlight = null, latestSync = null, shuttingDown = false;
const pages = {
 overview: ['Wallet overview', 'A simpler way to connect with the Proxima network.', 'Overview'],
 send: ['Send PROX', 'Every transfer starts with a careful review.', 'Send'],
 receive: ['Receive PROX', 'Your public address. Your place in the network.', 'Receive'],
 delegations: ['Delegations', 'Understand your delegated funds. Choose when to bring them home.', 'Delegations'],
 activity: ['Your activity', 'A transparent record of your local transfer attempts.', 'Activity'],
 security: ['Security & backup', 'Protect what only you can recover.', 'Security & backup'],
 settings: ['Network settings', 'Choose how your wallet connects to Proxima.', 'Network settings']
};
function notify(message, error = false) {
 $('notification').textContent = message;
 $('notification').classList.toggle('error', error);
 $('notification').hidden = !message;
}
function format(motes) {
 const n = BigInt(motes);
 return (n / 1000000n).toLocaleString('en-US') + '.' + (n % 1000000n).toString().padStart(6, '0');
}
function show(view) {
 if (busy || !pages[view]) return;
 document.querySelectorAll('[data-page]').forEach(el => { el.hidden = el.dataset.page !== view; });
 document.querySelectorAll('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
 $('page-title').textContent = pages[view][0];
 $('page-subtitle').textContent = pages[view][1];
 $('breadcrumb').textContent = pages[view][2];
 notify('');
 if (['send', 'receive', 'activity', 'security', 'delegations'].includes(view) && !state.exists) notify('Create or restore your wallet from Overview first.');
}
function render() {
 const locked = state.exists && !state.unlocked;
 document.body.classList.remove('awaiting-state');
 document.body.classList.toggle('wallet-locked', locked);
 document.querySelector('.workspace').inert = locked;
 document.querySelector('.sidebar').inert = locked;
 const enteringLock = locked && $('unlock-screen').hidden;
 $('unlock-screen').hidden = !locked;
 if (enteringLock) { $('unlock-error').hidden = true; $('unlock-password').focus(); }
 $('lock-wallet').hidden = !state.unlocked;
 $('lock-wallet').disabled = busy;
 if (locked) {
  if ($('setup-dialog').open) $('setup-dialog').close();
  clearTimeout(syncTimer); latestSync = null;
  $('send-form').reset(); $('total-balance').textContent = '—';
  $('short-address').textContent = '—'; $('full-address').textContent = '—';
  $('qr').removeAttribute('src'); $('qr').hidden = true;
 }

 $('welcome').hidden = state.exists;
 $('wallet-overview').hidden = !state.exists;
 $('backup-reminder').hidden = state.backedUp;
 $('refresh').disabled = !state.unlocked || !api || busy || Boolean(syncFlight);
 if (state.exists && state.unlocked) {
  $('short-address').textContent = 'a/' + state.holderId.slice(0, 12) + '…' + state.holderId.slice(-12);
  $('full-address').textContent = 'a/' + state.holderId;
  if (state.qr) { $('qr').src = state.qr; $('qr').hidden = false; }
 }
 $('backup-state').textContent = state.exists ? (state.backedUp ? 'Encrypted backup copy saved' : 'Backup recommended — optional for sending') : 'No wallet created yet';
 $('node-url').value = state.settings.nodeUrl;
 $('witnesses').value = state.settings.witnesses.join('\n');
 $('sequencer').value = state.settings.sequencer;
 document.querySelectorAll('#send-form button, #backup-form button, [data-copy], #support-tip, #support-copy').forEach(el => { el.disabled = !state.unlocked || !api || busy; });
 renderHistory();
 renderLiveDetails();
}
function renderHistory() {
 const list = $('history');
 list.replaceChildren();
 if (!state.history.length) {
  const div = document.createElement('div'); div.className = 'empty';
  const strong = document.createElement('strong'); strong.textContent = 'A fresh start';
  const p = document.createElement('p'); p.textContent = 'Transfers you make from this wallet will appear here.';
  div.append(strong, p); list.append(div); return;
 }
 for (const item of state.history) {
  const row = document.createElement('div'); row.className = 'history-item';
  const amount = document.createElement('strong'); amount.textContent = activityTitle(item);
  const status = document.createElement('span'); status.className = 'history-status ' + item.status; status.textContent = statusLabel(item);
  const date = document.createElement('small'); date.textContent = new Date(item.date).toLocaleString();
  const recipient = document.createElement('code'); recipient.textContent = item.delegationId ? 'Delegation: $/' + item.delegationId : 'To: a/' + item.recipient;
  const txid = document.createElement('code'); txid.textContent = item.txid ? 'Transaction: ' + item.txid : 'No submission receipt';
  const check = document.createElement('small'); check.className = 'tx-check'; check.textContent = item.statusCheckedAt ? 'Node check: ' + new Date(item.statusCheckedAt).toLocaleString() : 'Not checked on this node yet';
  row.append(amount, status, date, recipient, txid, check); list.append(row);
 }
}
function activityTitle(item) {
 if (item.kind === 'delegation-stop') return 'Request unfreeze' + (item.fee ? ' · max cost ' + format(item.motes) + ' PROX' : '');
 if (item.kind === 'delegation-withdraw') return 'Withdraw delegation · ' + format(item.motes) + ' PROX before fee';
 return format(item.motes) + ' PROX';
}
function statusLabel(item) {
 if (item.node && item.node !== state.settings.nodeUrl) return item.status + ' · different node';
 return { submitted: 'Pending · submitted', pending: 'Pending · not included', included: 'Included · node-reported', unknown: 'Uncertain · check before retrying', failed: 'Failed', cancelled: 'Cancelled' }[item.status] || item.status;
}
function renderLiveDetails() {
 const scoped = state.history.filter(h => h.node === state.settings.nodeUrl || !h.node);
 const pending = scoped.filter(h => ['pending', 'submitted'].includes(h.status)).length;
 const uncertain = scoped.filter(h => h.status === 'unknown').length;
 $('overview-pending').textContent = 'Pending outgoing: ' + pending + (uncertain ? ' · Uncertain: ' + uncertain : '');
 $('receive-pending').textContent = String(pending);
 $('receive-uncertain').textContent = String(uncertain);
 $('receive-node').textContent = state.settings.nodeUrl;
 $('receive-backup').textContent = state.backedUp ? 'Encrypted copy saved' : 'Not saved — recommended, not required to send';
 const r = latestSync;
 const b = r?.balance;
 const amountText = value => value == null ? '—' : format(value);
 for (const [field, ids] of [['spendableMotes', ['spendable-balance', 'receive-spendable']], ['delegatedMotes', ['delegated-balance', 'receive-delegated']], ['tagAlongReclaimableMotes', ['tagalong-balance', 'receive-tagalong']]]) {
  for (const id of ids) $(id).textContent = amountText(b?.[field]) + (id.startsWith('receive-') && b?.[field] != null ? ' PROX' : '');
 }
 $('receive-tag-config').textContent = (state.settings.sequencer === 'random' ? 'Random active sequencer' : '$/' + state.settings.sequencer) + ' · fee preference at least 0.1 PROX; actual fee shown before signing';
 $('breakdown-note').textContent = !b ? 'Balance categories not checked yet.' : (r.stale ? 'Stale · ' : '') + (b.partial || b.scanPartial ? 'Partial / lower-bound results · ' : '') + 'Checked ' + new Date(b.fetchedAt).toLocaleTimeString() + '. Separate engine snapshots; categories are not a single spend-all quote.' + (b.detailsError ? ' Some details unavailable: ' + b.detailsError : '');
 renderDelegations(b, Boolean(r?.stale));
 const slot = !r?.networkError && Number.isInteger(r?.lrbSlot) ? r.lrbSlot.toLocaleString('en-US') : '—';
 $('overview-lrb-slot').textContent = slot;
 $('receive-lrb-slot').textContent = slot;
 $('lrb-note').textContent = !r ? 'Connect your wallet to observe the node’s LRB.' : r.networkError ? 'Node unavailable · LRB slot unknown' : r.lrbSlot === null ? 'LRB slot unavailable from this node response' : 'Node-reported · checked ' + new Date(r.checkedAt).toLocaleTimeString() + ' · not a finality guarantee';
 $('receive-balance').textContent = b ? format(b.motes) : '—';
 $('receive-outputs').textContent = b ? b.outputs + (b.partial ? ' (partial)' : '') : '—';
 $('receive-checked').textContent = r?.checkedAt ? new Date(r.checkedAt).toLocaleString() : '—';
 $('receive-verified').textContent = b ? new Date(b.fetchedAt).toLocaleString() + (r.stale ? ' · stale' : '') : '—';
 $('receive-branch').textContent = r?.branch || '—';
 $('receive-connection').textContent = !r ? 'Not checked' : r.networkError ? 'Offline / unreachable' : r.balanceError ? 'Node online · balance verification failed' : 'Node reachable';
 const list = $('receive-history'); list.replaceChildren();
 const recent = scoped.slice(0, 5);
 if (!recent.length) { const p = document.createElement('p'); p.className = 'small muted'; p.textContent = 'No outgoing transfers recorded on this device.'; list.append(p); }
 for (const item of recent) {
  const row = document.createElement('div'); row.className = 'history-item';
  const amount = document.createElement('strong'); amount.textContent = activityTitle(item);
  const status = document.createElement('span'); status.className = 'history-status ' + item.status; status.textContent = statusLabel(item);
  const id = document.createElement('code'); id.textContent = item.txid ? 'Transaction: ' + item.txid : 'No receipt — verify the outcome before retrying';
  row.append(amount, status, id); list.append(row);
 }
}
let delegationRenderKey = '';
function renderDelegations(balance, stale) {
 const items = balance?.delegations;
 const key = JSON.stringify([items, stale, busy, state.unlocked, balance?.detailsError]);
 $('delegation-note').textContent = !items ? 'Delegation details unavailable. Unlock and refresh your wallet.' : (stale ? 'Stale snapshot. Refresh before acting. ' : '') + items.length + ' delegation(s) · balances and state checked ' + new Date(balance.fetchedAt).toLocaleTimeString();
 if (key === delegationRenderKey) return;
 delegationRenderKey = key;
 const list = $('delegation-list'); list.replaceChildren();
 if (!items?.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = items ? 'No delegations found in this snapshot.' : 'No verified delegation list available.'; list.append(p); return; }
 for (const item of items) {
  const row = document.createElement('div'); row.className = 'delegation-row';
  const info = document.createElement('div');
  const amount = document.createElement('strong'); amount.textContent = format(item.motes) + ' PROX';
  const status = document.createElement('span'); status.className = 'delegation-status'; status.textContent = item.status;
  const id = document.createElement('code'); id.textContent = '$/' + item.id;
  const target = document.createElement('small'); target.textContent = 'Target: ' + (item.target ? '$/' + item.target : 'Unavailable');
  info.append(amount, status, id, target);
  const button = document.createElement('button'); button.className = 'button secondary';
  button.textContent = item.frozen ? 'Request unfreeze' : 'Withdraw to wallet';
  button.dataset.delegationId = item.id; button.dataset.mode = item.frozen ? 'stop' : 'withdraw';
  button.disabled = busy || stale || !state.unlocked || !api || Boolean(balance.detailsError);
  button.addEventListener('click', () => operation(async () => {
   try {
    const result = await api.delegation({ id: item.id, mode: item.frozen ? 'stop' : 'withdraw' });
    if (result.cancelled) notify('Delegation action cancelled.');
    else notify(item.frozen ? 'Unfreeze request submitted, not yet processed. Check Activity and refresh the delegation state before withdrawing. Do not send duplicate requests.' : 'Withdrawal submitted. Funds are not yet confirmed spendable. Check Activity and refresh.');
   } finally { state = await api.state(); latestSync = null; }
  }, 'Rechecking delegation ownership and status. Review all costs in the desktop confirmation…'));
  row.append(info, button); list.append(row);
 }
}
function applySync(result) {
 latestSync = result;
 if (result.history) state.history = result.history;
 const b = result.balance;
 $('total-balance').textContent = b ? format(b.motes) : '—';
 $('balance-note').textContent = b ? (result.stale ? 'Stale · ' : '') + (b.partial ? 'Partial · ' : '') + b.outputs + ' controlled outputs · Verified ' + new Date(b.fetchedAt).toLocaleTimeString() : 'Balance not yet verified. Automatic retries are enabled.';
 $('network-status').textContent = result.networkError ? 'Offline · retrying' : result.balanceError ? 'Verification failed' : 'Node online';
 $('auto-sync-status').textContent = result.networkError ? 'Auto-refresh: retrying · last attempt ' + new Date(result.checkedAt).toLocaleTimeString() : 'Auto-refresh every 3s · checked ' + new Date(result.checkedAt).toLocaleTimeString() + (result.transactionError ? ' · Some TX checks unavailable' : '');
 renderHistory(); renderLiveDetails();
}
function scheduleSync(delay = 3000) {
 clearTimeout(syncTimer);
 if (!api || shuttingDown || !state.unlocked) return;
 syncTimer = setTimeout(() => refresh(false), delay);
}
async function refresh(manual = false) {
 if (!api || !state.unlocked || shuttingDown) return;
 if (syncFlight) return syncFlight;
 if (busy || (!manual && document.hidden)) { scheduleSync(); return; }
 clearTimeout(syncTimer);
 const started = Date.now();
 $('refresh').disabled = true;
 syncFlight = (async () => {
  try {
   const result = await (manual ? api.balance() : api.sync());
   if (!state.unlocked || busy || result.skipped || result.cancelled || result.node !== state.settings.nodeUrl) return;
   applySync(result);
   if (manual) notify(result.balanceError || result.networkError || 'Wallet refreshed. Transaction inclusion is node-reported.', Boolean(result.balanceError || result.networkError));
  } catch (err) {
   if (!busy) {
    $('network-status').textContent = 'Refresh failed';
    $('auto-sync-status').textContent = 'Auto-refresh will retry; last verified data may be stale.';
    if (latestSync) { latestSync = { ...latestSync, stale: true, networkError: err.message }; renderLiveDetails(); }
    if (manual) notify(err.message, true);
   }
  } finally {
   syncFlight = null;
   $('refresh').disabled = busy || !state.unlocked;
   scheduleSync(Math.max(0, 3000 - (Date.now() - started)));
  }
 })();
 return syncFlight;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(0); });
window.addEventListener('beforeunload', () => { shuttingDown = true; clearTimeout(syncTimer); });
async function operation(fn, message = 'Working…') {
 if (!api) { notify('This is an interface preview. Use the Windows desktop app for wallet operations.', true); return; }
 if (busy) return;
 busy = true; document.body.classList.add('busy');
 document.querySelectorAll('button').forEach(el => { el.disabled = true; });
 notify(message);
 try { await fn(); }
 catch (error) { notify(error.message, true); }
 finally {
  document.querySelectorAll('input[type=password]').forEach(el => { el.value = ''; });
  busy = false; document.body.classList.remove('busy');
  document.querySelectorAll('button').forEach(el => { el.disabled = false; });
  render();
  scheduleSync(0);
 }
}
function setup(mode) {
 if (!api) { notify('Create and restore are available only in the desktop app. This browser preview does not handle keys.', true); return; }
 if (busy) return;
 setupMode = mode;
 $('setup-form').reset(); $('setup-error').hidden = true;
 $('setup-title').textContent = mode === 'create' ? 'Create your wallet' : 'Restore your wallet';
 $('setup-description').textContent = mode === 'create' ? 'A new key is generated on this device and encrypted with your password.' : 'Choose a .key, .json or .txt file. Text imports accept a 128-hex private key, private_key: HEX, or an explicitly labelled seed: HEX. JSON backups also work in .txt files. Review the recovered address before saving.';
 $('old-password-label').hidden = mode !== 'import';
 $('setup-submit').textContent = mode === 'create' ? 'Create encrypted wallet' : 'Choose file & import';
 $('setup-dialog').showModal();
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => show(button.dataset.view)));
document.querySelectorAll('[data-setup]').forEach(button => button.addEventListener('click', () => setup(button.dataset.setup)));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); show('overview'); });
$('close-setup').addEventListener('click', () => { if (!busy) { $('setup-dialog').close(); $('setup-form').reset(); } });
$('setup-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else $('setup-form').reset(); });
$('setup-form').addEventListener('submit', async event => {
 event.preventDefault();
 if ($('new-password').value !== $('confirm-password').value) { $('setup-error').textContent = 'The passwords do not match.'; $('setup-error').hidden = false; return; }
 const values = { password: setupMode === 'create' ? $('new-password').value : $('old-password').value, newPassword: $('new-password').value, acknowledged: $('risk-check').checked };
 await operation(async () => {
  try {
   const result = await api[setupMode](values);
   if (!result) { notify('Restore cancelled. No wallet was changed.'); return; }
   state = result; $('setup-dialog').close();
   notify('Your wallet is unlocked for this session. No password is needed when sending. Lock or close the app when you step away. Backups are recommended, but optional.');
  } catch (error) { $('setup-error').textContent = error.message; $('setup-error').hidden = false; throw error; }
  finally { values.password = ''; values.newPassword = ''; }
 }, 'Preparing your encrypted wallet…');
});
$('unlock-form').addEventListener('submit', event => {
 event.preventDefault();
 const value = { password: $('unlock-password').value };
 $('unlock-password').value = ''; $('unlock-error').hidden = true;
 operation(async () => {
  try { state = await api.unlock(value); notify('Wallet unlocked for this session.'); }
  catch (error) { $('unlock-error').textContent = error.message; $('unlock-error').hidden = false; }
  finally { value.password = ''; }
 }, 'Unlocking wallet…');
});
$('lock-wallet').addEventListener('click', () => operation(async () => {
 state = await api.lock(); notify('');
}, 'Locking wallet…'));
api?.onLocked(() => {
 clearTimeout(syncTimer);
 state = { ...state, unlocked: false, holderId: '', history: [], qr: null };
 latestSync = null; render();
 api.state().then(result => { state = result; render(); }).catch(error => notify(error.message, true));
});
$('refresh').addEventListener('click', () => refresh(true));
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => operation(async () => { await api.copyAddress(); notify('Public address copied. Compare it with the displayed address before sharing.'); })));
$('backup-form').addEventListener('submit', event => {
 event.preventDefault();
 operation(async () => { const result = await api.backup(); if (result) { state = result; notify('Encrypted backup copy saved. Restoring it still requires your desktop-wallet password. Keep that password separately.'); } else notify('Backup cancelled.'); }, 'Saving an encrypted backup copy…');
});
$('send-form').addEventListener('submit', event => {
 event.preventDefault();
 const values = { recipient: $('recipient').value.trim(), amount: $('amount').value.trim() };
 operation(async () => {
  try {
   const result = await api.send(values);
   if (result.cancelled) notify('Transfer cancelled.');
   else { $('send-form').reset(); notify('Transaction submitted to the node, not yet confirmed. Check Activity for the transaction ID. Do not resend just because settlement takes time.'); $('total-balance').textContent = '—'; $('balance-note').textContent = 'Refresh after the transfer settles.'; }
  } finally { state = await api.state(); }
 }, 'Checking transfer details. Review the desktop confirmation when it appears…');
});
$('settings-form').addEventListener('submit', event => {
 event.preventDefault();
 const values = { nodeUrl: $('node-url').value.trim(), witnesses: $('witnesses').value.split('\n').map(s => s.trim()).filter(Boolean), sequencer: $('sequencer').value.trim() };
 operation(async () => {
  const result = await api.settings(values);
  if (result) { state = result; latestSync = null; $('total-balance').textContent = '—'; $('balance-note').textContent = 'Connection changed. Refresh to fetch a balance.'; $('network-status').textContent = 'Not connected'; notify('Network settings saved. Refresh your balance to test the connection.'); }
  else notify('Settings unchanged.');
 }, 'Review the network settings in the desktop dialog…');
});
$('support-copy').addEventListener('click', () => operation(async () => {
 const address = await api.copySupport();
 notify('Support address copied: ' + address);
}));
$('support-tip').addEventListener('click', () => {
 if (busy || !state.unlocked || !api) return;
 show('send');
 $('recipient').value = state.supportAddress;
 $('amount').value = '';
 $('amount').focus();
 window.scrollTo({ top: 0, behavior: 'smooth' });
 notify('Optional tip to the wallet creator. Enter your amount, then review the recipient and fee. Nothing has been sent.');
});
$('docs').addEventListener('click', () => operation(async () => { await api.docs(); notify('Documentation opened in your browser.'); }));
if (!api) { $('browser-warning').hidden = false; render(); }
else api.state().then(result => { state = result; render(); scheduleSync(0); }).catch(error => notify(error.message, true));
