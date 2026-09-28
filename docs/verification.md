# Verification, 9 September 2026

## Functional evidence

- 15 Node tests passed, using isolated fake accounts. These exercise token-refresh persistence, account-ID matching despite old duplicate email metadata, invalid targets, failed graceful quit, outgoing credentials refreshed during shutdown, failed-reopen rollback, conversation-file preservation, stale selection detection, login retention when usage is unavailable, concurrent auth changes, process locking, duplicate imports, and local HTTP access controls.
- MCP newline-delimited initialization and tool discovery passed; six tools are exposed.
- Plugin manifest validation and skill validation passed. Installed through the existing personal `cristian-local` marketplace.
- Live current-account identity and usage were read through the bundled Codex app server. The current Pro session was saved. At the latest check used for the screenshot, its weekly Codex balance was 78% remaining and reset-credit count was 0. These values change over time.
- Imported two distinct old rotator sessions, skipping one byte-identical duplicate. Both older sessions returned reconnect-required. Original profiles were left untouched.
- Codex in-app browser checks: refresh completes with live results; Save current completes without duplicating the current account; the normal ChatGPT authorization URL is created; cancelling closes the login flow; expanded model limits show both 5-hour and weekly Spark windows.
- A live account switch and successful browser login callback remain unverified because the second account's imported session is expired. The user must reconnect an account to exercise those paths. No real switch, logout, reset-credit redemption, or forced desktop shutdown was performed.
- The Mac launcher bundle was installed and its property list and JavaScript entry point validated. Its purpose is access when assistant usage is exhausted.

## Visual evidence

Concept: `dashboard-concept.png`, generated using the built-in image tool. Prompt: a complete, white, table-based local Account Manager screen, green accents, three illustrative account rows, usage windows, reset-credit counts, Save / Connect / Switch controls, current-account strip, and connection footer. The concept data are illustrative.

Rendered screenshots: `dashboard-desktop.png` and `dashboard-mobile.png`, captured with Codex IAB. The concept and final desktop render were both inspected using view_image. Desktop viewport matched the actual concept image dimensions, 1504 × 1046; page width and height matched the viewport with no overflow. Mobile viewport was 390 × 844, with measured content width 375, no horizontal overflow. Temporary viewport overrides were reset.

Comparison ledger:

| Point | Review and resolution |
| --- | --- |
| Information architecture | Header, title/actions, current strip, table, helper, connection footer are in the concept order. |
| Palette | Pure white background, subtle neutral surfaces, charcoal text and emerald actions retained. |
| Typography | System sans, large bold heading, smaller table labels and secondary email/status copy. Tightened desktop spacing to fit the full surface. |
| Table and controls | Five desktop columns retained. Current first, reconnect actions green, current action disabled; additional model limits expand inline. |
| Spacing | Reduced row padding and made success notices transient so the entire primary desktop screen fits at concept size. |
| Mobile | Table rows stack with explicit column labels; actions remain accessible without horizontal overflow. |
| Copy | Main heading, explanatory text, action labels, section title and footer match. Runtime status and account data replace illustration-only content. |
| Deliberate differences | Real names/emails and three actual profiles; Pro labels; precise local reset times; last-check timestamp and stale/error messages; expandable secondary model windows; no fake native traffic-light frame. |

The implemented surface was visually checked against the concept for layout, palette, typography, spacing, table anatomy and action treatment. Live state necessarily changes row content and height; there are no known blocking clipping or layout defects.

## Token history update

Added account-wide token history from `account/usage/read`, with Today, 7 days, 30 days and All time per saved account, deduplicated combined totals, and a daily breakdown. UTC calendar windows include today. Failed reads preserve clearly marked old snapshots; missing data stays N/A; aggregate coverage is explicit. 26 tests pass, including 7 token-specific tests for date boundaries, invalid daily data, duplicate profiles, missing counts, stale reads, and distinct-account sums. Live reads succeeded across four saved accounts. IAB rendered all four rows and combined totals and expanded 40 provider-reported daily rows within the last 30 days. At a 390px viewport the document width was 375px, without horizontal overflow. Temporary viewport override was reset. Plugin and skill validators passed; workspace, installed source, and cache files match.

## Durable usage on this Mac

Added a separate SQLite ledger for local Codex OpenAI token events, retained independently of removable login profiles. Per-account Today/7/30-day/All-recorded counters and a combined Mac total include removed accounts and unassigned historical usage. Reconnecting an identified account continues its history; another account receives a separate record. Account attribution uses the observed selected account at turn start. Earlier logs and unobserved/ambiguous intervals remain unassigned. The tracker stores counters and metadata without copying prompts, scans incrementally while the dashboard service runs, and serializes overlapping scans with a process lock.

36 tests pass: 26 Node tests and 10 Python ledger tests. Ledger regressions cover repeated/copied events, inherited fork history, interleaved cumulative counters, partial writes, restart persistence, deleted source files, removed/reconnected accounts, different accounts, UTC period boundaries, uncertain attribution, and non-OpenAI providers. Historical import finished over the available local logs. Live checks confirmed ongoing updates and new attributed turns without changing the active account. No real account was removed or switched for this test.

The installed dashboard shows four connected account rows plus Unassigned local history, combined local totals, and 31 daily local rows at verification. Desktop and 390px mobile layouts were inspected; document widths were within each viewport (1413/1428 desktop and 375/390 mobile). Evidence: `local-usage-desktop.png` and `local-usage-mobile.png`. Temporary viewport overrides were reset and the dashboard was left open. Plugin and skill validation passed. Local counts are log-derived, not a billing audit; the recorder must be started through the launcher after reboot, and gaps cannot reliably be assigned to accounts.

## Usage view switch

Added This Mac / Account-wide buttons above token history. Only the selected table and daily breakdown is displayed, with pressed-state accessibility and browser-local preference retained after reload. Saved-account switching remains available above both views. Browser checks confirmed switching both ways, four account-wide rows and all period columns, reload persistence, and 375px content width at a 390px viewport. The temporary override was reset and Account-wide left selected. JavaScript syntax check and plugin validation passed; refreshed package installed through the personal marketplace. This update changes presentation only; existing token accounting and auth behavior are unchanged.

## Focus design implementation — 10 September 2026

Implemented the user-selected `03-focus.png` concept as the real dashboard, replacing the previous white table UI. Reference: `ui-concepts/03-focus.png`. Final renders: `focus-desktop.png` and `focus-mobile.png`.

At the reference 1536 × 1024 viewport, the sidebar is 350px wide; quota panels begin at y=97 with height 142; token panel begins at y=251 with height 392; comparison table begins at y=655. Footer bottom is y=979; the document is exactly 1536 × 1024. These closely match the reference's structure and geometry. Graphite surfaces, green controls, avatars, fine borders, compact metrics, chart, and comparison rows follow the supplied image. Real account labels and available provider data replace all illustrative values. Additional quota windows and reset-credit details remain available through the info buttons; stale/partial history is labeled. Reset redemption remains in Codex, and the dashboard's corresponding mockup button is disabled with an explanatory title. The original concept marker was replaced with Local to this Mac.

Functional browser checks passed for account inspection without changing the active login, sidebar search and clearing, independent local/account-wide views, Today/7/30-day/all-time chart controls, additional usage windows, switch confirmation/cancel, and account removal confirmation/cancel. No real login switch or account removal was performed. Live quota/history refresh completed. The local ledger keeps retained/unknown account rows. Stable account IDs now accompany local daily buckets, preventing collisions between duplicate display labels; the all-time chart can use all recorded daily history. Long histories are grouped into bounded date buckets without dropping tokens.

At 390px viewport width, both document and body widths are 375px; account cards and comparison tables scroll within their own containers, and chart labels adapt to the available width. Temporary viewport overrides were reset. The installed dashboard was left open. Browser error log was empty. 40 tests pass: 30 Node tests and 10 Python ledger tests; new tests cover data-source isolation, local identities with duplicate labels, unavailable data, UTC boundaries and long-history chart totals. Plugin/skill validators pass and workspace files match installed source/cache.

## Account renaming and screenshot privacy — 10 September 2026

Added Rename account to each account's ellipsis menu, backed by a locked, validated metadata-only rename endpoint and `account_manager_rename` MCP tool. Names survive refresh and retain profile identity, credentials, and token history. Added a visible Screenshot privacy toggle in the sidebar on desktop and mobile. It substitutes Account 1/2/etc. labels, neutral avatar numbers, and Email hidden throughout account lists, current/selected account headers, comparison tables, menus, title attributes and accessible labels. Archived local identities are also masked. Enabling clears identifying search text and obsolete dialog content. Rename inputs hide the existing value and mask new text while privacy is on; error notices avoid identities. The preference survives reloads at the same dashboard address. It changes presentation only, not the underlying account data or usage figures.

46 tests pass: 36 Node and 10 Python. Added tests for rename persistence, metadata-only changes, invalid input, disk failure, authenticated HTTP rename, saved/archived privacy aliases, restoration, and message redaction. Live browser verified rename submission using an unchanged existing name, masked names/emails in both data views and rename/remove dialogs, no prefilled identity in the private rename form, persistence after reload, and restoration after disabling. No accounts were given new names during testing. Audited rendered text, tooltip/title attributes, accessible labels and input values against the original saved identities: zero identity leaks. At a 390px viewport document width is 375px. Browser error log empty; temporary viewport reset. Privacy was left enabled. Screenshot: `privacy-mode.png`. Plugin and skill validators pass; workspace/source/cache content matches.

## Empty-chart axis correction — 10 September 2026

Fixed the reported vertical-axis overflow: the former empty-data scale multiplied a fractional 0.4 step into 1.2000000000000002 and rendered that raw value. Token axes now use integer steps. Empty charts show only the zero tick and a No recorded tokens in this period message. Six focused usage-view tests pass, including new empty/low/high-value axis regressions. Installed and verified live in privacy mode, Account 1 → This Mac → 7 days: labels are zero, the empty-state message, and Sep 4–10, without fractional artifacts. JavaScript syntax and plugin validation passed.

## Live sessions, reasoning, tokens and estimated cost — September 10, 2026

- Added a Live sessions sidebar view with Active/Recent filters, latest model and reasoning effort, per-session input/output/cache totals, estimated USD cost and a click-through breakdown including latest-turn usage. Existing account controls and screenshot privacy remain available.
- Read-only local metadata and rollout scanning, with a separate derived SQLite index. Bounded background import keeps task lifecycle visible immediately; recent token events are deduplicated when backfill reaches them. Forks cannot overwrite child metadata with an embedded parent session_meta, and backup paths cannot duplicate session rows or totals.
- Active status requires an open turn and a log signal within two minutes; silent or stale snapshots are explicit. Unknown account attribution stays unassigned. Session scope is at most 100 tasks updated in the last 7 days, with each session’s imported lifetime totals clearly labeled.
- Standard USD API rates verified against https://developers.openai.com/api/docs/pricing and GPT-6 Astra model documentation on 2026-09-10. Includes cache reads/writes and long-context tiers; reasoning output is not counted twice. Unknown rates yield N/A/partial. Estimates exclude tools, Fast mode and regional surcharges and are not subscription bills.
- 60 tests passed: 38 Node tests, 10 durable-ledger Python tests and 12 session-reader/pricing tests. The session API is covered by bearer-token and origin rejection checks. JavaScript syntax, plugin manifest and skill validation passed.
- Live IAB QA: real active sessions appeared and updated across polls; the Active filter excluded finished tasks; details showed model/effort and token/cost breakdowns. Desktop at 1536×1024 and mobile at 390×844 had no page overflow. Session table remains horizontally scrollable on narrow screens. Privacy masks session titles/projects and account identities; no visible emails or identity-bearing session tooltips when enabled. No browser error logs.
- Screenshot evidence: live-sessions-desktop.png and live-sessions-mobile.png (privacy enabled). Historical session import runs in the background and displays partial indicators until complete. The existing local account ledger was not rewritten. No real account switches, removals or reset redemptions were used for testing.

## Missing account-wide Today bucket — September 10, 2026

A fresh refresh returned daily history ending on September 9 for all four saved accounts, with no September 10 bucket. The period reducer previously summed the empty current-day selection to zero. Today now remains null until that date is explicitly reported; an explicit zero bucket still renders as zero. Metrics, comparison rows/total, and the Today chart explain Not reported. Local counts remain independent and unchanged. Provider reporting latency or calendar timezone was not established from the date-only response.

39 Node tests passed, including the regression for missing versus explicit-zero daily buckets and partial combined totals. Plugin and skill validation passed. Live browser checks confirmed all four account-wide Today cells and the total show Not reported, the Today chart explains the missing report, and This Mac still showed about 54.4M local tokens today. No browser errors.

## Persistent session sorting

Added Sort by controls to Live sessions: Active first (active group first, then tokens descending) and Total tokens (all displayed sessions by tokens descending). Sorting reapplies on live updates and is remembered in localStorage. Unknown totals still importing sort after known counts. Sorting copies the displayed list and does not change aggregate usage or account selection. Browser QA verified descending token totals across 83 real sessions, active grouping and descending totals within groups, reload persistence, and no desktop page overflow. JavaScript syntax validation passed.

## All accounts statistics selector

Added Show stats for in the upper-right detail header, with All accounts and each saved account. The default/fallback when no individual account is selected is All accounts; selection is remembered. Sidebar account selection and the selector stay synchronized, and All accounts overview now opens combined stats. Combined token cards use the existing authoritative comparison totals; the chart sums daily local ledger rows (including removed/unassigned history) or deduplicated account-wide snapshots. Individual quota/actions are hidden in aggregate mode and restored for an individual selection.

17 focused token/usage-view tests passed, including duplicate profile identity handling, distinct IDs sharing an email, retained/unassigned local records and unavailable history. Live checks verified card/table total equality for both sources, combined chart sums, individual quota restoration and persisted All accounts selection after reload. At 390px viewport width, the selector fit and the page had no horizontal overflow. Browser error log was empty. Plugin and skill validation passed; updated installed plugin without restarting Codex or changing its login.

## Sidebar quota reset dates

Each saved account now displays Resets + date/time directly below its quota usage bar, using the same quota window as that bar. Reset credits remain a separate line. Times use the browser's local timezone; hover shows the full timestamp with timezone and quota window. Missing timestamps display N/A. JavaScript syntax and plugin validation passed. Live browser verification showed dates beneath all four account usage bars, including in All accounts mode, with no clipping in the desktop render.

## Sidebar account plan

Added a compact plan badge beside each account name, using the planType returned by the account identity endpoint. Formatting is shared with the detail header. Unknown plans show Plan N/A; no 20x tier is inferred from a Pro response. Plan badges remain visible with screenshot privacy. JavaScript syntax and plugin validation passed. Reloaded the user's open dashboard in Chrome and verified Pro appeared on all four sidebar cards.
