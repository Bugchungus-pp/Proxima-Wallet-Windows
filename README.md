Proxima desktop wallet (Windows 10 / 11 x64)
The independent app in proxima-wallet/ wraps the official proxi wallet engine, pinned to upstream commit 8a424c8e3436a0624f40c1f3d56cb6f2e817f084. It is unofficial, experimental, unsigned, and not independently audited. Proxima is in pre-launch: the network may stop or reset without notice and its tokens can cease to exist. Do not treat this build as a production wallet.

Download and use
Download v0.1.5 Windows x64 ZIP (approximately 162 MB; this download uses the requesting user's Genspark session).

Extract the entire ZIP to a local folder; do not run from inside the ZIP.
Open Proxima Wallet.exe. Go and Node.js are bundled/not needed by end users.
Create a wallet with a strong password, or restore a supported .key, .json, or .txt file. On subsequent opens, enter your desktop-wallet password once to unlock the session.
Recommended (optional): use Security & backup to save an encrypted backup outside the app data folder, preferably to offline storage. Keep the password separately. There is no seed phrase and no password-reset service.
Check Network settings, then refresh your balance. Public node availability is not guaranteed. Published defaults use unencrypted HTTP; witnesses must belong to the same network and at least one distinct witness is required.
Receive via your public address/QR. Sending uses your unlocked session: no password prompt, backup file, or backup export is required. Review the exact recipient, amount and fee in the separate desktop confirmation before signing.
SHA256 of the distributed ZIP: 9799f7c69c586a8393717a8aa74b2581e60922a2ee09a280f21f0ae785a523cb. Verify with Get-FileHash .\Proxima-Wallet-0.1.5-Windows-x64.zip -Algorithm SHA256 in PowerShell. The executable has no publisher signature; do not disable your security software or run an untrusted/modified copy.

Wallet data is stored under %APPDATA%\proxima-desktop-wallet, not beside the portable executable. Back up proxima.key before moving/deleting app data. The app refuses to overwrite an existing wallet. Restoring into a fresh Windows user profile is supported. Full legacy YAML profiles, mnemonic phrases, hardware wallets, mining, creating new delegations and redelegation are outside this version's scope. Stopping and withdrawing existing controlled delegations are supported as described below.

Balances show total controlled tokens, including locked/delegated amounts; that is not the same as spendable balance. Activity shows local outgoing attempts, not incoming history. Node-reported inclusion is not a finality guarantee. After a timeout or crash, check the node/recipient before retrying to avoid a duplicate payment.

v0.1.5 fund categories, delegation unfreeze and creator tips
Balance details on Overview and Receive:

Spendable: the official own-output scan's plain siglock category, before transaction fees. Excludes chains and conditional outputs; this is not a guarantee that all funds fit in one transaction or satisfy every live ledger check.
Delegated: total funds in delegations controlled by this wallet as master, including frozen and currently unlockable ones.
Tag-along · reclaimable: unused tag-along outputs in the wallet's reclaim or public-cleanup window. Excludes pending tag-alongs and is not lifetime fees paid. They require official proxi node compact before becoming plain spendable funds; this desktop version does not initiate compaction. Public-window funds may be claimed by another participant first. Receive also shows the configured sequencer and 0.1 PROX fee preference, not a guaranteed final fee.
Data comes from proxi node balance --verbose and read-only proxi node compact scan --no-public. No public abandoned-output walk is run. These bounded commands share the existing change/manual/30-second balance-cache cadence; the lightweight node check still runs every 3 seconds. The two reads are separate snapshots, not a single atomic spend-all quote. Missing/malformed details show unknown, and stale/partial results are labelled.
Delegations lists full IDs, targets, balances and frozen/unlockable status:

Request unfreeze runs official proxi node delegate askstop <id>. It first reloads controlled delegations and checks the selected ID/status. Native dialogs show the exact tag-along fee from spendable funds and maximum compensation deducted from the delegation. Nonzero compensation requires a separate approval. This submits a request, not an immediate unfreeze: the sequencer must process it. A request's inclusion does not prove the delegation has stopped. Near the natural unfreeze slot the engine may refuse an unnecessary early-stop request; wait and refresh instead. Waiting avoids early-stop compensation, but withdrawal still pays its own fee.
Once unlockable, Withdraw to wallet uses official proxi node killchain <id> for that single, freshly verified delegation only. It permanently ends the chain and returns its balance minus the displayed fee to this wallet. Frozen, foreign, missing or invalid IDs are refused. Generic/bulk chain destruction is not exposed.
Both actions use the unlocked session without another password prompt, retain native confirmations, log receipts in Activity and never retry automatically. Earlier included/pending/uncertain actions trigger a repeat-action warning. askstop does not honor --nowait in the pinned engine, so its read-only watcher is stopped only after an authorized successful submission receipt is observed. Timeouts after approval remain uncertain; check the node before trying again.
