'use strict';
const { spawn } = require('node:child_process');
const { prompt } = require('./core.cjs');
// No shell, user-controlled executable, CLI flags, or automatic command retry.
function environment(password) {
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (password) env.PROXIMA_KEY_PASSPHRASE = password;
  return env;
}
function run(executable, args, { cwd, input, password, approve, signal, timeout = 90000, spawnFn = spawn, parsePrompt = prompt, promptOrder = ['unknown', 'fee'], stopOnReceipt } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(executable, args, { cwd, env: environment(password), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stopped = false, processing = false, offset = 0;
    let lastPrompt = -1, declined = false, finalAccepted = false;
    const abort = () => fail(new Error('Operation cancelled. Check Activity before retrying a submitted transaction.'));
    const timer = setTimeout(() => fail(new Error('Operation timed out. A send may already have reached the node; do not blindly retry.')), timeout);
    function fail(err) {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill();
      reject(err);
    }
    child.on('error', () => fail(new Error('Wallet engine could not start. Re-extract the complete application folder.')));
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => read(chunk, false));
    child.stdout.on('data', chunk => read(chunk, true));
    async function read(chunk, canPrompt) {
      if (stopped) return;
      output += chunk.toString('utf8');
      if (output.length > 1024 * 1024) return fail(new Error('Engine response exceeded safety limit.'));
      if (canPrompt && stopOnReceipt && stopOnReceipt(output)) {
        if (!finalAccepted || processing) return fail(new Error('Unexpected submission receipt before authorization.'));
        stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        child.kill(); resolve(output); return;
      }
      if (!approve || !canPrompt || processing) return;
      try {
        const next = parsePrompt(output.slice(offset));
        if (!next) return;
        const index = promptOrder.indexOf(next.kind);
        if (index < 0 || index <= lastPrompt || declined) throw new Error('Unexpected repeated confirmation; stopped.');
        lastPrompt = index;
        processing = true;
        offset = output.length;
        const accepted = await approve(next, output);
        processing = false;
        if (stopped) return;
        declined = !accepted;
        finalAccepted = accepted && lastPrompt === promptOrder.length - 1;
        child.stdin.write(accepted ? 'y\n' : 'n\n');
        // Keep stdin open: EOF would cause upstream prompts to accept defaults.
      } catch (err) { fail(err); }
    }
    child.on('close', code => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code !== 0) reject(new Error(output.slice(-14000) || 'Wallet engine failed.'));
      else resolve(output);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    if (input !== undefined) child.stdin.end(input);
    else if (!approve) child.stdin.end();
  });
}
module.exports = { run, environment };
