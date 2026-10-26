
## Proxima desktop wallet (Windows 10 / 11 x64)

The independent app in `proxima-wallet/` wraps the official `proxi` wallet engine,
pinned to upstream commit `8a424c8e3436a0624f40c1f3d56cb6f2e817f084`.
It is unofficial, experimental, unsigned, and not independently audited.
Proxima is in pre-launch: the network may stop or reset without notice and
its tokens can cease to exist. Do not treat this build as a production wallet.

### Download and use

[Download v0.1.5 Windows x64 ZIP]

1. Extract the **entire** ZIP to a local folder; do not run from inside the ZIP.
2. Open `Proxima Wallet.exe`. Go and Node.js are bundled/not needed by end users.
3. Create a wallet with a strong password, or restore a supported `.key`, `.json`, or `.txt` file.
   On subsequent opens, enter your desktop-wallet password once to unlock the session.
4. Recommended (optional): use **Security & backup** to save an encrypted backup outside the app data folder,
   preferably to offline storage. Keep the password separately. There is no seed
   phrase and no password-reset service.
5. Check **Network settings**, then refresh your balance. Public node availability
   is not guaranteed. Published defaults use unencrypted HTTP; witnesses must
   belong to the same network and at least one distinct witness is required.
6. Receive via your public address/QR. Sending uses your unlocked session: no
   password prompt, backup file, or backup export is required. Review the exact recipient, amount and fee in
   the separate desktop confirmation before signing.

SHA256 of the distributed ZIP:
`9799f7c69c586a8393717a8aa74b2581e60922a2ee09a280f21f0ae785a523cb`.
Verify with `Get-FileHash .\Proxima-Wallet-0.1.5-Windows-x64.zip -Algorithm SHA256`
in PowerShell. The executable has no publisher signature; do not disable your
security software or run an untrusted/modified copy.

Wallet data is stored under `%APPDATA%\proxima-desktop-wallet`, not beside the
portable executable. Back up `proxima.key` before moving/deleting app data.
The app refuses to overwrite an existing wallet. Restoring into a fresh Windows
user profile is supported. Full legacy YAML profiles, mnemonic phrases, hardware
wallets, mining, creating new delegations and redelegation are outside this version's scope.
Stopping and withdrawing existing controlled delegations are supported as described below.

Balances show total controlled tokens, including locked/delegated amounts;
that is not the same as spendable balance. Activity shows local outgoing attempts,
not incoming history. **Node-reported inclusion is not a finality guarantee.** After a timeout or crash,
check the node/recipient before retrying to avoid a duplicate payment.

### v0.1.5 fund categories, delegation unfreeze and creator tips

**Balance details** on Overview and Receive:
- **Spendable:** the official own-output scan's plain `siglock` category, before
  transaction fees. Excludes chains and conditional outputs; this is not a guarantee
  that all funds fit in one transaction or satisfy every live ledger check.
- **Delegated:** total funds in delegations controlled by this wallet as master,
  including frozen and currently unlockable ones.
- **Tag-along · reclaimable:** unused tag-along outputs in the wallet's reclaim or
  public-cleanup window. Excludes pending tag-alongs and is not lifetime fees paid.
  They require official `proxi node compact` before becoming plain spendable funds;
  this desktop version does not initiate compaction. Public-window funds may be
  claimed by another participant first. Receive also shows the configured
  sequencer and 0.1 PROX fee preference, not a guaranteed final fee.
- Data comes from `proxi node balance --verbose` and read-only
  `proxi node compact scan --no-public`. No public abandoned-output walk is run.
  These bounded commands share the existing change/manual/30-second balance-cache
  cadence; the lightweight node check still runs every 3 seconds. The two reads
  are separate snapshots, not a single atomic spend-all quote. Missing/malformed
  details show unknown, and stale/partial results are labelled.

**Delegations** lists full IDs, targets, balances and frozen/unlockable status:
1. **Request unfreeze** runs official `proxi node delegate askstop <id>`. It first
   reloads controlled delegations and checks the selected ID/status. Native dialogs
   show the exact tag-along fee from spendable funds and maximum compensation
   deducted from the delegation. Nonzero compensation requires a separate approval.
   This submits a request, not an immediate unfreeze: the sequencer must process it.
   A request's inclusion does not prove the delegation has stopped. Near the natural
   unfreeze slot the engine may refuse an unnecessary early-stop request; wait and
   refresh instead. Waiting avoids early-stop compensation, but withdrawal still
   pays its own fee.
2. Once unlockable, **Withdraw to wallet** uses official `proxi node killchain <id>`
   for that single, freshly verified delegation only. It permanently ends the chain
   and returns its balance minus the displayed fee to this wallet. Frozen, foreign,
   missing or invalid IDs are refused. Generic/bulk chain destruction is not exposed.
3. Both actions use the unlocked session without another password prompt, retain
   native confirmations, log receipts in Activity and never retry automatically.
   Earlier included/pending/uncertain actions trigger a repeat-action warning.
   `askstop` does not honor `--nowait` in the pinned engine, so its read-only watcher
   is stopped only after an authorized successful submission receipt is observed.
   Timeouts after approval remain uncertain; check the node before trying again.


Passed 36 Node tests plus Electron regressions for real key/session handling,
production balance parsing with mocked CLI reports, early-stop/withdrawal approval
and cancellation, absent allowance rejection, frozen/foreign ID guards, lock during
approval, uncertain outcomes, failed scan handling and tip copy/prefill. Responsive
UI tests passed and screenshots were reviewed. No live delegation or funded transfer
was performed; actual Windows runtime remains unverified. The ZIP was checked for
CRC integrity, expected resources, matching source and absence of wallet/test files.

### Text import and OS compatibility

The restore picker supports official JSON keystores saved as `.txt`, raw 128-hex
Ed25519 private keys, `private_key: <128 hex>` text, and an explicitly labelled
`seed: <64 hex>` containing a real 32-byte Ed25519 seed. Optional `public_key` and
`holder_id`/`address` fields must match. UTF-8 (optional BOM) and BOM-marked UTF-16
LE/BE Notepad files are accepted, up to 16 KiB. Mnemonic words are not supported.
Bare 64-hex values are rejected because they may be public addresses; never label
an address as a seed to bypass this check. For plaintext imports, leave the old
password empty and set a new password for the encrypted copy. Compare the
recovered public address before saving. The original file is not deleted or
modified, so keep plaintext originals private and offline.

Windows 7/8/8.1 are **not supported, in either 32-bit or 64-bit mode**. No 32-bit
package is supplied. [Electron 23+](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice)
and [Go 1.21+](https://go.dev/doc/go1.21#windows) require Windows 10 or newer;
this app uses Electron 45 and the pinned official Proxima engine requires Go 1.26.
Changing installer architecture does not fix those runtime requirements.

### Security and validation

- Native engine handles key generation, Argon2id/AES-256-GCM keystores and signing.
  Plaintext private keys are never sent to the renderer or a node.
- The official CLI receives the password only in its short-lived child environment,
  not in arguments or a password file. An administrator or malware can still read
  process memory; reliable JavaScript memory zeroization is not guaranteed.
- Renderer uses context isolation, a sandbox, CSP, no Node integration, no remote
  content and a fixed, sender-validated IPC interface. Commands use no shell.
- Passed: 36 JavaScript safety/native-integration tests; Go adapter and upstream
  keystore tests; real Electron create/backup/restore, QR, clipboard, overwrite
  refusal and crash-recovery smoke tests on Linux (headless test flags only).
  Additional desktop tests cover UTF-16/plaintext TXT imports and a mocked network
  verifies the 3-second timer, preserved typing, minimum-send rejection and Receive
  details. Mock-network results do not prove live-network inclusion or finality.
  Browser preview navigation and responsive-layout tests also passed.
- Built and inspected the Windows x64 ZIP and native PE executables. **Not yet
  verified on actual Windows 10/11 machines or with a live funded transfer.**
  No real funds were moved during testing. NSIS installer generation is configured
  but the supplied artifact is the portable ZIP, not an installer.

### Updating the portable app

An encrypted `.key` backup is recommended, not required. Close the old wallet, extract the entire
new ZIP to a new folder, and launch its `Proxima Wallet.exe`. The same Windows
user's app-data wallet is reused; do not delete the `%APPDATA%` wallet directory.
Enter your existing desktop-wallet password on the new unlock screen; no reimport
or password change is needed. Only one copy can run at a time. No Go or Node.js installation is needed to use
the ZIP. Actual Windows 10/11 runtime validation remains outstanding; the stability
work above was tested on Linux with Electron and mocked read-only network data.

