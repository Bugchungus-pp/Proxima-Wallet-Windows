'use strict';
const MAX = (1n << 64n) - 1n;
const MIN_SEND = 10000000n;
const FEE_FLOOR = 100000n;
const DEFAULTS = Object.freeze({
  nodeUrl: 'http://65.21.170.230:8001',
  witnesses: ['http://79.137.70.25:8001', 'http://51.254.47.76:8001'],
  sequencer: 'random'
});
function text(v, max = 1024) {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw new Error('Invalid input');
  return v;
}
function password(v, isNew = false) {
  text(v, 1024);
  if (!v && !isNew) throw new Error('Enter the desktop-wallet password chosen when creating or importing this wallet.');
  if (!v || (isNew && Buffer.byteLength(v) < 12) || Buffer.byteLength(v) > 1024) throw new Error('Password must be 12–1024 bytes when creating a wallet.');
  return v;
}
function holder(v) {
  const h = text(v, 66).trim().replace(/^a\//, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(h)) throw new Error('Enter a 64-character Proxima holder ID (optionally prefixed a/).');
  return h;
}
function toMotes(v) {
  text(v, 40);
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(v)) throw new Error('Enter a positive PROX amount with at most 6 decimals, without commas.');
  const [whole, frac = ''] = v.split('.');
  const n = BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, '0'));
  if (n <= 0n || n > MAX) throw new Error('Amount is outside the supported range.');
  return n.toString();
}
function sendAmount(v) {
  const motes = toMotes(v);
  if (BigInt(motes) < MIN_SEND) throw new Error('Minimum send is 10 PROX plus at least 0.1 PROX in fees.');
  return motes;
}
function fromMotes(v) {
  const n = BigInt(v);
  return (n / 1000000n).toString() + '.' + (n % 1000000n).toString().padStart(6, '0');
}
function nodeURL(v) {
  const s = text(v, 512).trim();
  let u;
  try { u = new URL(s); } catch { throw new Error('Enter a valid node URL.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('Use an HTTP(S) node origin without credentials, paths or query strings.');
  return u.origin;
}
function settings(v) {
  if (!v || !Array.isArray(v.witnesses) || v.witnesses.length > 5) throw new Error('Provide 1–5 witness node URLs.');
  const nodeUrl = nodeURL(v.nodeUrl);
  const witnesses = [...new Set(v.witnesses.map(nodeURL))].filter(u => u !== nodeUrl);
  if (!witnesses.length) throw new Error('At least one witness different from the primary node is required.');
  const sequencer = text(v.sequencer || 'random', 48).toLowerCase();
  if (sequencer !== 'random' && !/^[a-f0-9]{48}$/.test(sequencer)) throw new Error('Sequencer must be random or a 48-character chain ID.');
  return { nodeUrl, witnesses, sequencer };
}
function profile(s, hid) {
  // JSON is valid YAML. No user-supplied text is interpolated into YAML source.
  return JSON.stringify({ wallet: { key_file: 'proxima.key', holder_id: holder(hid) },
    api: { node_url: s.nodeUrl, node_urls: s.witnesses, timeout_sec: 15 },
    tag_along: { fee: Number(FEE_FLOOR), sequencer_id: s.sequencer } }, null, 2);
}
function balance(output) {
  const match = output.match(/TOTAL controlled on (\d+) outputs: ([\d_]+)/);
  if (!match) throw new Error('Unrecognized balance response. See the node report; balance has not been assumed to be zero.');
  return { motes: match[2].replaceAll('_', ''), outputs: match[1], partial: /results are partial/.test(output) };
}
function prompt(output) {
  const match = output.match(/(?:^|\n)(send to the unknown holder anyway\?|send will cost ([\d_]+) of fees paid to tag-along sequencer [^\r\n]{1,128}\. Proceed\?) \(([Yy])\/([Nn])\) $/);
  if (!match) return null;
  if (match[2]) {
    const fee = BigInt(match[2].replaceAll('_', ''));
    if (fee <= 0n || fee > MAX) throw new Error('Invalid sequencer fee.');
    return { kind: 'fee', fee: fee.toString(), label: match[1] };
  }
  return { kind: 'unknown', label: match[1] };
}
function receipt(output) {
  if (!/transaction .* submitted successfully/.test(output)) return null;
  return output.match(/-------- tx OK ([a-f0-9]{64}) \(len = \d+\)/)?.[1] || null;
}

const SUPPORT_ADDRESS = 'a/2ca32c1108befd9ff2e84ffa054bb8804c90054320faccc729b9c33b5614eebe';
function chainID(value) {
  const id = text(value, 50).trim().replace(/^\$\//, '').toLowerCase();
  if (!/^[a-f0-9]{48}$/.test(id)) throw new Error('Select a full 48-character delegation ID.');
  return id;
}
function integer(value) {
  if (typeof value !== 'string' || !/^\d+(?:_\d+)*$/.test(value)) throw new Error('Invalid engine amount.');
  const n = BigInt(value.replaceAll('_', ''));
  if (n > MAX) throw new Error('Engine amount exceeds supported range.');
  return n.toString();
}
function balanceDetails(output) {
  const total = balance(output);
  const categories = {};
  let sum = 0n, count = 0n;
  for (const [key, label] of [['nonChainMotes', 'non-chain'], ['delegatedMotes', 'delegation'], ['otherChainMotes', 'non-delegation chain']]) {
    const matches = [...output.matchAll(new RegExp('^\\s*on\\s+(\\d+) ' + label + ' outputs:\\s+([\\d_]+)\\s*$', 'gm'))];
    if (matches.length !== 1) throw new Error('Unrecognized balance categories.');
    categories[key] = integer(matches[0][2]);
    sum += BigInt(categories[key]); count += BigInt(matches[0][1]);
    if (key === 'delegatedMotes') categories.delegationCount = Number(matches[0][1]);
  }
  if (sum.toString() !== integer(total.motes) || count.toString() !== total.outputs) throw new Error('Inconsistent balance totals.');
  const delegations = [];
  const section = output.match(/(?:^|\n)DELEGATIONS \((\d+)\):\s*\n([\s\S]*?)(?=\n(?:NON-DELEGATION CHAINS|NATIVE TOKEN|NO NATIVE|FOUNDRIES|NO FOUNDRIES)|$)/);
  if (categories.delegationCount && (!section || Number(section[1]) !== categories.delegationCount)) throw new Error('Missing delegation list.');
  if (section) {
    const rows = [...section[2].matchAll(/^\s*\$\/([a-f0-9]{48})\s+([\d_]+)\s+(.+?) maxFrozen: \d+([^\n]*)(?:\n\s+delegation target \$\/([a-f0-9]{48}))?/gm)];
    for (const row of rows) {
      const status = row[3];
      const frozen = status.match(/^frozen until slot (\d+) /);
      const safe = status.match(/^safe revocation until slot (\d+) /);
      if (!frozen && !safe && !['on hold', 'can be unlocked by master'].includes(status)) throw new Error('Unknown delegation state.');
      delegations.push({ id: row[1], motes: integer(row[2]), status, frozen: Boolean(frozen), unfreezeSlot: frozen ? Number(frozen[1]) : null, target: row[5] || null });
    }
    if (delegations.length !== categories.delegationCount || new Set(delegations.map(d => d.id)).size !== delegations.length || delegations.reduce((sum, d) => sum + BigInt(d.motes), 0n).toString() !== categories.delegatedMotes) throw new Error('Incomplete delegation list.');
  }
  return { ...total, ...categories, delegations };
}
function spendableScan(output) {
  // Only parse the wallet's own indexed outputs, never the public abandoned pool.
  const head = output.match(/windows evaluated at slot (\d+); (\d+) UTXO\(s\) indexed under this account/);
  if (!head || !output.includes('YOURS, COMPACTABLE') || output.includes('PUBLIC, ABANDONED')) throw new Error('Unrecognized spendable scan.');
  const values = new Map(); let count = 0n;
  for (const m of output.matchAll(/^\s+(swd-accept|tagalong-cleanup|tagalong-reclaim|swd-reclaim|siglock|needs-return|unknown|pending|on chains|no claim)\s+(\d+)\s+([\d_]+)(?:[^\n]*)$/gm)) {
    if (values.has(m[1])) throw new Error('Duplicate spendable category.');
    values.set(m[1], integer(m[3])); count += BigInt(m[2]);
  }
  if (count.toString() !== head[2]) throw new Error('Incomplete spendable scan.');
  const reclaim = BigInt(values.get('tagalong-reclaim') || '0') + BigInt(values.get('tagalong-cleanup') || '0');
  return { spendableMotes: values.get('siglock') || '0', tagAlongReclaimableMotes: integer(reclaim.toString()), scanSlot: Number(head[1]), scanPartial: output.includes('LOWER BOUND') };
}
function delegationPrompt(output) {
  let m = output.match(/(?:^|\n)authorise sequencer (\$\/[a-f0-9]{12}\.\.) to take up to ([\d_]+) out of delegation (\$\/[a-f0-9]{12}\.\.)\? \([Yy]\/[Nn]\) $/);
  if (m) return { kind: 'allowance', targetShort: m[1], allowance: integer(m[2]), idShort: m[3] };
  m = output.match(/(?:^|\n)send request to stop delegation (\$\/[a-f0-9]{12}\.\.) to the sequencer \$\/([a-f0-9]{48})\? \([Yy]\/[Nn]\) $/);
  if (m) return { kind: 'stop', idShort: m[1], target: m[2] };
  m = output.match(/(?:^|\n)discontinue chain \$\/([a-f0-9]{48})\? \([Yy]\/[Nn]\) $/);
  return m ? { kind: 'withdraw', id: m[1] } : null;
}
function oneMatch(output, regex) {
  const matches = [...output.matchAll(regex)];
  if (matches.length !== 1) throw new Error('Missing or ambiguous delegation cost report.');
  return matches[0];
}
function stopCosts(output, id) {
  const target = oneMatch(output, /^delegation target ID: \$\/([a-f0-9]{48})\s*$/gm)[1];
  const summary = oneMatch(output, /^delegation (\$\/[a-f0-9]{12}\.\.) -> (\$\/[a-f0-9]{12}\.\.), unfreezes in slot (\d+), balance ([\d_]+)\s*$/gm);
  if (summary[1] !== '$/' + id.slice(0, 12) + '..' || summary[2] !== '$/' + target.slice(0, 12) + '..') throw new Error('Delegation identity mismatch.');
  const fee = integer(oneMatch(output, /^\s+paid from this wallet \(tag-along fee\): ([\d_]+)\s*$/gm)[1]);
  const allowance = integer(oneMatch(output, /^\s+taken from the delegation \(allowance\): ([\d_]+)\s*$/gm)[1]);
  const compensation = integer(oneMatch(output, /^\s+estimated compensation to the sequencer: ([\d_]+)\s*$/gm)[1]);
  if (BigInt(fee) === 0n || BigInt(fee) + BigInt(allowance) !== BigInt(compensation)) throw new Error('Inconsistent delegation costs.');
  return { target, fee, allowance, compensation, motes: integer(summary[4]) };
}
function withdrawalCosts(output, id) {
  const chain = oneMatch(output, /^chain \$\/([a-f0-9]{48}): balance ([\d_]+)\s*$/gm);
  if (chain[1] !== id) throw new Error('Delegation identity mismatch.');
  const feeMatch = oneMatch(output, /^using (?:profile tag-along fee ([\d_]+) \(sequencer \$\/[a-f0-9]{12}\.\. requires [\d_]+\)|the minimum tag-along fee ([\d_]+) required by sequencer \$\/[a-f0-9]{12}\.\. \(profile has [\d_]+\))\s*$/gm);
  const fee = integer(feeMatch[1] || feeMatch[2]), motes = integer(chain[2]);
  if (BigInt(fee) <= 0n || BigInt(motes) <= BigInt(fee)) throw new Error('Delegation does not cover its fee.');
  return { fee, motes, net: (BigInt(motes) - BigInt(fee)).toString(), allowance: '0' };
}
function submissionReceipt(output) {
  return output.match(/^-------- tx OK ([a-f0-9]{64}) \(len = \d+\)/m)?.[1] || null;
}
module.exports = { SUPPORT_ADDRESS, chainID, integer, balanceDetails, spendableScan, delegationPrompt, stopCosts, withdrawalCosts, submissionReceipt, MIN_SEND, FEE_FLOOR, sendAmount, MAX, DEFAULTS, text, password, holder, toMotes, fromMotes, nodeURL, settings, profile, balance, prompt, receipt };
