'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const revision = '8a424c8e3436a0624f40c1f3d56cb6f2e817f084';
const platform = process.argv[2] || process.platform;
if (!['linux', 'win32'].includes(platform)) throw new Error('Supported targets: linux, win32');
const upstream = path.join(root, '.vendor', 'proxima');
const env = { ...process.env, GOMAXPROCS: '2', CGO_ENABLED: '0', GOTOOLCHAIN: 'local',
  GOPATH: path.join(root, '.cache', 'go'), GOCACHE: path.join(root, '.cache', 'gobuild'),
  GOTMPDIR: path.join(root, '.cache', 'tmp'), GOOS: platform === 'win32' ? 'windows' : 'linux', GOARCH: 'amd64' };
for (const dir of [path.dirname(upstream), env.GOTMPDIR, path.join(root, 'bin', platform)]) fs.mkdirSync(dir, { recursive: true });
function run(cmd, args, cwd = root, overrides = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...env, ...overrides }, stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}
if (!fs.existsSync(path.join(upstream, '.git'))) {
  run('git', ['init', upstream]);
  run('git', ['remote', 'add', 'origin', 'https://github.com/lunfardo314/proxima.git'], upstream);
}
run('git', ['fetch', '--depth', '1', 'origin', revision], upstream);
run('git', ['checkout', '--detach', revision], upstream);
const helper = path.join(upstream, 'desktophelper');
fs.mkdirSync(helper, { recursive: true });
for (const f of ['main.go', 'main_test.go']) fs.copyFileSync(path.join(root, 'native', f), path.join(helper, f));
const go = process.env.GO_BINARY || 'go';
const suffix = platform === 'win32' ? '.exe' : '';
if (platform === process.platform) run(go, ['test', '-p', '2', './desktophelper', './util/keystore'], upstream);
for (const [name, pkg] of [['proxi', './proxi'], ['wallet-keys', './desktophelper']]) {
  run(go, ['build', '-p', '2', '-trimpath', '-ldflags=-s -w', '-o', path.join(root, 'bin', platform, name + suffix), pkg], upstream);
}
fs.copyFileSync(path.join(upstream, 'LICENSE'), path.join(root, 'bin', platform, 'PROXIMA-LICENSE'));
fs.writeFileSync(path.join(root, 'bin', platform, 'UPSTREAM-REVISION'), revision + '\n');
console.log('Built pinned official CLI and keystore helper for ' + platform);
