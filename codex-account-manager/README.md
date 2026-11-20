# Codex Account Manager

A local Codex plugin and dashboard for multiple user-owned ChatGPT accounts. Source is in `codex-account-manager/`; the personal installed source is `~/plugins/codex-account-manager`.

## Use

The dashboard opens on **Usage**: a black graphite page with a breadcrumb filter (**Usage / account / provider**), time ranges (**Past 24h, 7 days, 30 days, 90 days**) and three views (**Cost, Tokens, Limits**). The sidebar keeps the searchable saved accounts and navigates between **Usage**, **Accounts & limits** (the per-account quota, reset credits, token chart, and comparison table) and **Live sessions**. Selecting a row only changes the account being inspected. **Switch & reopen** explicitly changes Codex’s active login. Chart controls cover Today, 7 days, 30 days, and available all-time history; long histories are grouped into date buckets with exact counts in chart tooltips. Reset-credit redemption remains in Codex’s account menu.

In a new Codex thread, ask **Open Account Manager**. The plugin opens a local dashboard where you can:

- See **what your local AI coding usage would cost at API rates**, for Codex and Claude Code together: total and per provider (sessions, share, tokens), an hourly, 4-hour, or daily chart with hover details, totals (processed, cached input, uncached input, output, cache savings), **cost by type** (input, cache read, cache write, output), **cost by speed** (Standard, Fast with its premium, and Codex requests whose speed is not recorded), and a ranked **breakdown by model, account, project, or time**. **Tokens** shows the same page measured in tokens. **Limits** shows each saved account’s Codex quota windows, reset times, and reset credits.
- Filter by account: each saved Codex account (attributed from the local ledger), unassigned Codex history, and each Claude Code profile directory (`~/.claude`, `~/.claude-02`, …). Filter by provider: Codex or Claude Code.

- Save your current login with a recognizable name.
- Use **… → Rename account** to change its display name. Credentials, account identity, and usage history are retained.
- Turn on **Screenshot privacy** at the bottom of the sidebar before sharing a screenshot. Names become Account 1, Account 2, etc.; emails and identifying initials are hidden in both usage views, menus, tooltips, and confirmation dialogs. Turn it off to show identities again. The preference survives reloads at the same dashboard address. This is display privacy; usage figures stay visible.
- Connect another account with the normal ChatGPT sign-in page, without logging the app out. Sign-in opens in a private window (a dedicated Chrome, Chromium, Brave, Edge, or Vivaldi profile, or a Firefox private window) so your existing ChatGPT cookies are not reused. If no private-mode browser is installed, use the sign-in button as a normal link.
- Refresh per-account usage: all returned limit buckets, remaining percentages, durations, and scheduled reset times.
- See available reset-credit counts and expiration information separately from usage resets.
- Use **This Mac / Account-wide** to switch the token table between retained local history and provider-reported usage per saved account across devices. The view selection is remembered in that browser. Account switching remains available under Saved accounts via **Switch & reopen**.
- Track **Usage on this Mac** independently of saved logins: Today, 7 days, 30 days, All recorded, and daily rows, per account and combined. Removing a profile preserves its local history; reconnecting the same identified account continues its record. A different account gets a separate record. Existing logs are imported as **Unassigned local history** because they contain no account identity. New turns are attributed from observed account selection at turn start; ambiguous switches and unobserved gaps remain unassigned.
- See token counts per account and a combined total for Today, 7 days, 30 days, and All time, plus a daily breakdown. These come from Codex's account-wide history API, not local conversation estimates. Day windows use UTC calendar dates and include today. Counts sum the daily buckets returned by Codex; missing dates add no reported tokens, and history can lag. All time is the lifetime total returned by Codex. Combined totals count duplicate identified logins once, show partial coverage when an account is unavailable, and mark older data after a failed check.
- Switch with **Switch & reopen** after finishing active work.
- Remove a saved account using **… → Remove account** in its sidebar row or the selected-account header. The confirmation names the account. Removing even the current saved profile leaves the app signed in; previous recovery backups are kept.

Terminal fallback:

```sh
node ~/plugins/codex-account-manager/scripts/account-manager.cjs open
node ~/plugins/codex-account-manager/scripts/account-manager.cjs save "Personal"
node ~/plugins/codex-account-manager/scripts/account-manager.cjs connect "Work"
node ~/plugins/codex-account-manager/scripts/account-manager.cjs refresh
```

`open` prints the authenticated local dashboard URL. It can be opened in the Codex browser panel or a normal browser. The local dashboard process runs independently of the desktop app, so it survives account-switch restarts. It starts on demand, not at OS login.

## Why this differs from the old rotator

The old tool saves a static `auth.json` and restores it later, without first saving refreshed credentials from the outgoing session. This manager lets the bundled Codex app server handle account authentication and refresh, persists the resulting session, and verifies a target before switching. It uses private per-account homes for inactive checks and a private temporary home plus compare-and-swap for current-account checks. It never decodes tokens itself.

Switching gracefully quits the desktop app, captures the final outgoing login, makes a private backup, selects the checked destination, and reopens the same application and Codex home. It does not modify conversation, workspace, project, or settings files. If reopening fails, it restores the outgoing auth. If the app refuses to quit normally, it stops before changing the login. This is a controlled app restart; in-flight tasks should be completed first. It is not a seamless hot swap.

## Storage and limits

- Account sessions and metadata: `~/.codex-account-manager/`; directories 0700, files 0600. These are local credential files, not encrypted Keychain entries. Do not sync or share this folder. The `browser-profile` subfolder holds only private-mode browser state for sign-in; sign-in cookies are ephemeral and cleared when that window closes.
- Local counters live in `~/.codex-account-manager/local-tracking/local-usage.sqlite`, separately from removable account sessions. The recorder reads OpenAI token events from this Mac's Codex `sessions` and `archived_sessions`, stores counters and attribution metadata without copying prompts, and filters repeated/copied events. It uses the reported request total, which includes cached input, without adding reasoning tokens again. These are locally recorded tokens, not a billing audit or usage from other machines. Deleting original logs does not delete already recorded counts.
- The recorder runs about every 15 seconds while the dashboard service runs, including after closing its browser tab. After a Mac restart, open the launcher to resume. Historical import runs in batches; partial totals and recorder errors are visible. Unobserved activity can be recovered from remaining logs but cannot reliably be assigned to an account. Calendar windows use UTC and include today.
- Original rotator profiles are preserved. Import deduplicates byte-identical sessions.
- No credentials or account metadata are stored in this repository or plugin package.
- The HTTP service binds only to 127.0.0.1, uses a random bearer capability, validates origin/host, and does not expose credential files. The capability is held in a URL fragment and browser session storage.
- The Usage page reads an index at `~/.codex-account-manager/usage-index/usage.sqlite` (0600). It holds one row per model request from the last 92 days: provider, time, session and project names, model, speed, token counts, and cost estimates. It never stores prompts, completions, or reasoning text. It reads Codex `sessions` and `archived_sessions`, including finished rollouts that Codex compressed to `.jsonl.zst` (decompressed with Node’s built-in zstd, Node 22.15+), and every `~/.claude*/projects` folder. The first import reads all logs from the last 92 days in batches (about 65 GB took 5–6 minutes on this Mac); progress is shown at the top of the page. After that only new lines are read, about every 15 seconds.
- Costs are API-equivalent estimates at Standard list prices from `scripts/session-pricing.json` (OpenAI and Claude API rates, checked November 20, 2026), not subscription bills. Long-context rates apply above each model’s threshold, Claude 5-minute and 1-hour cache writes are priced separately, and Claude Fast mode is billed at 2×. Codex logs do not record Fast mode, so Codex requests use Standard rates; Codex cache writes use the 30-minute write rate. Models without a published rate count toward tokens but not cost, and are named on the page. Edit the pricing file to change rates; existing rows are repriced automatically.
- Usage page times are local; the older token tables use UTC calendar dates.
- Account checks use the installed Codex protocol, with the bundled desktop binary preferred over an older CLI. No inference requests are made. No reset credits are redeemed.
- Expired/revoked sessions require sign-in again. Unknown API values appear as N/A. Usage older than 2 minutes, or from a failed check, is marked stale. A Pro plan is reported as Pro; the API does not establish a 20x tier label.
- Safe app quit/reopen currently targets macOS ChatGPT/Codex app bundles. A new login requires completing the browser authentication yourself; Account Manager opens a private-mode browser window when one is available and otherwise falls back to the sign-in link. A live cross-account switch remains to be validated with a second valid account.
- Do not run the old rotator alongside this manager to switch accounts; it can restore obsolete credentials independently.

## Development and verification

Requires Node.js 20+, Python 3 with its standard SQLite module, and the installed Codex desktop app/CLI on macOS. The plugin has no npm dependencies.

```sh
node --test codex-account-manager/test/*.test.cjs
python3 codex-account-manager/test/local-tracker-test.py
python3 codex-account-manager/test/live-sessions-test.py
python3 codex-account-manager/test/usage-index-test.py
node codex-account-manager/scripts/account-manager.cjs open
```

Tests use fake sessions in temporary directories. They cover token rotation, outgoing-session capture during quit, invalid targets, restart rollback, conversation preservation, duplicate import, process locking, HTTP authorization, and private sign-in browser launch. Live checks verify account identity, usage, reset counts, and normal sign-in initiation/cancellation. Browser checks use Codex IAB.

Environment overrides for isolated development: `CODEX_ACCOUNT_MANAGER_HOME`, `CODEX_HOME`, `CODEX_ACCOUNT_BINARY`, `CODEX_ACCOUNT_PYTHON`, `CODEX_ACCOUNT_CLAUDE_HOME` (one or more Claude config directories separated by `:`; by default every `~/.claude*` folder with a `projects/` subfolder), `CODEX_ACCOUNT_MANAGER_PORT` (fixed dashboard port), and `CODEX_ACCOUNT_PRIVATE_BROWSER` (path to a Chromium-family or Firefox `.app`). Production defaults should normally be used.

## Open without spending Codex usage

The installed Mac launcher is `~/Applications/Codex Account Manager.app`. Open it from Finder or Spotlight to bring up the dashboard in your browser, even if you cannot start another assistant turn. It starts the same private local service as the plugin. To reinstall the launcher after moving the plugin source, run `node ~/plugins/codex-account-manager/scripts/install-launcher.cjs`.

Design and browser QA evidence are in `docs/verification.md`.
