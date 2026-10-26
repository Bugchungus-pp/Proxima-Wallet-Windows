'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const binary = path.resolve(__dirname, '../bin', process.platform, 'wallet-keys' + (process.platform === 'win32' ? '.exe' : ''));
const enabled = fs.existsSync(binary);
function call(input) {
 const p = spawnSync(binary, [], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 30000 });
 assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout);
}
test('real native executable creates, verifies and re-encrypts a compatible backup', { skip: !enabled }, () => {
 const created = call({ action: 'create', newPassword: 'native test passphrase' });
 assert.ok(created.keystore.crypto); assert.equal(created.keystore.private_key, undefined);
 assert.match(created.holderId, /^[0-9a-f]{64}$/);
 const verified = call({ action: 'verify', password: 'native test passphrase', keystore: created.keystore });
 assert.equal(verified.holderId, created.holderId);
 assert.ok(call({ action: 'verify', password: 'wrong', keystore: created.keystore }).error);
 const imported = call({ action: 'import', password: 'native test passphrase', newPassword: 'replacement passphrase', keystore: created.keystore });
 assert.equal(imported.holderId, created.holderId);
 assert.notEqual(imported.keystore.crypto.ciphertext, created.keystore.crypto.ciphertext);
 assert.equal(call({ action: 'verify', password: 'replacement passphrase', keystore: imported.keystore }).holderId, created.holderId);
 created.keystore.crypto.nonce = '00';
 assert.ok(call({ action: 'verify', password: 'native test passphrase', keystore: created.keystore }).error);
});
test('real native executable rejects oversized and malformed requests', { skip: !enabled }, () => {
 assert.ok(call('x'.repeat(65537)).error);
 assert.ok(call('{broken').error);
 assert.ok(call({ action: 'delete' }).error);
});
