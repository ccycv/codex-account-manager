# Codex Account Manager

A local Codex plugin and dashboard for multiple user-owned ChatGPT accounts. Source is in `codex-account-manager/`; the personal installed source is `~/plugins/codex-account-manager`.

## Use

The dashboard follows the selected Focus concept: a dark graphite two-pane layout with green accents, searchable saved accounts on the left, and the selected account’s quota, reset credits, token chart, and comparison table on the right. Selecting a row only changes the account being inspected. **Switch & reopen** explicitly changes Codex’s active login. Chart controls cover Today, 7 days, 30 days, and available all-time history; long histories are grouped into date buckets with exact counts in chart tooltips. Reset-credit redemption remains in Codex’s account menu.

In a new Codex thread, ask **Open Account Manager**. The plugin opens a local dashboard where you can:

- Save your current login with a recognizable name.
- Use **… → Rename account** to change its display name. Credentials, account identity, and usage history are retained.
- Turn on **Screenshot privacy** at the bottom of the sidebar before sharing a screenshot. Names become Account 1, Account 2, etc.; emails and identifying initials are hidden in both usage views, menus, tooltips, and confirmation dialogs. Turn it off to show identities again. The preference survives reloads at the same dashboard address. This is display privacy; usage figures stay visible.
- Connect another account with the normal ChatGPT sign-in page, without logging the app out.
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
node ~/plugins/codex-account-manager/scripts/account-manager.cjs refresh
```

`open` prints the authenticated local dashboard URL. It can be opened in the Codex browser panel or a normal browser. The local dashboard process runs independently of the desktop app, so it survives account-switch restarts. It starts on demand, not at OS login.

## Why this differs from the old rotator

The old tool saves a static `auth.json` and restores it later, without first saving refreshed credentials from the outgoing session. This manager lets the bundled Codex app server handle account authentication and refresh, persists the resulting session, and verifies a target before switching. It uses private per-account homes for inactive checks and a private temporary home plus compare-and-swap for current-account checks. It never decodes tokens itself.

Switching gracefully quits the desktop app, captures the final outgoing login, makes a private backup, selects the checked destination, and reopens the same application and Codex home. It does not modify conversation, workspace, project, or settings files. If reopening fails, it restores the outgoing auth. If the app refuses to quit normally, it stops before changing the login. This is a controlled app restart; in-flight tasks should be completed first. It is not a seamless hot swap.

## Storage and limits

- Account sessions and metadata: `~/.codex-account-manager/`; directories 0700, files 0600. These are local credential files, not encrypted Keychain entries. Do not sync or share this folder.
- Local counters live in `~/.codex-account-manager/local-tracking/local-usage.sqlite`, separately from removable account sessions. The recorder reads OpenAI token events from this Mac's Codex `sessions` and `archived_sessions`, stores counters and attribution metadata without copying prompts, and filters repeated/copied events. It uses the reported request total, which includes cached input, without adding reasoning tokens again. These are locally recorded tokens, not a billing audit or usage from other machines. Deleting original logs does not delete already recorded counts.
- The recorder runs about every 15 seconds while the dashboard service runs, including after closing its browser tab. After a Mac restart, open the launcher to resume. Historical import runs in batches; partial totals and recorder errors are visible. Unobserved activity can be recovered from remaining logs but cannot reliably be assigned to an account. Calendar windows use UTC and include today.
- Original rotator profiles are preserved. Import deduplicates byte-identical sessions.
- No credentials or account metadata are stored in this repository or plugin package.
- The HTTP service binds only to 127.0.0.1, uses a random bearer capability, validates origin/host, and does not expose credential files. The capability is held in a URL fragment and browser session storage.
- Account checks use the installed Codex protocol, with the bundled desktop binary preferred over an older CLI. No inference requests are made. No reset credits are redeemed.
- Expired/revoked sessions require sign-in again. Unknown API values appear as N/A. Usage older than 2 minutes, or from a failed check, is marked stale. A Pro plan is reported as Pro; the API does not establish a 20x tier label.
- Safe app quit/reopen currently targets macOS ChatGPT/Codex app bundles. A new login requires completing the browser authentication yourself. A live cross-account switch remains to be validated with a second valid account.
- Do not run the old rotator alongside this manager to switch accounts; it can restore obsolete credentials independently.

## Development and verification

Requires Node.js 20+, Python 3 with its standard SQLite module, and the installed Codex desktop app/CLI on macOS. The plugin has no npm dependencies.

```sh
node --test codex-account-manager/test/*.test.cjs
python3 codex-account-manager/test/local-tracker-test.py
node codex-account-manager/scripts/account-manager.cjs open
```

Tests use fake sessions in temporary directories. They cover token rotation, outgoing-session capture during quit, invalid targets, restart rollback, conversation preservation, duplicate import, process locking, and HTTP authorization. Live checks verify account identity, usage, reset counts, and normal sign-in initiation/cancellation. Browser checks use Codex IAB.

Environment overrides for isolated development: `CODEX_ACCOUNT_MANAGER_HOME`, `CODEX_HOME`, `CODEX_ACCOUNT_BINARY`, `CODEX_ACCOUNT_PYTHON`. Production defaults should normally be used.

## Open without spending Codex usage

The installed Mac launcher is `~/Applications/Codex Account Manager.app`. Open it from Finder or Spotlight to bring up the dashboard in your browser, even if you cannot start another assistant turn. It starts the same private local service as the plugin. To reinstall the launcher after moving the plugin source, run `node ~/plugins/codex-account-manager/scripts/install-launcher.cjs`.

Design and browser QA evidence are in `docs/verification.md`.
