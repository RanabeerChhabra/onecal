# Founders Meeting Agent

Reads every Gmail inbox and Google Calendar the founders connect and finds every confirmed meeting. That includes calendar invites, Calendly/Zoom/Teams confirmations, and plain "see you Thursday at 4" emails. It keeps **one shared Google Calendar, "Founders — All Meetings"**, up to date:

- Titles say whose meeting it is: `[R]`, `[H+A]`, `[R+H+A]`, …
- The same meeting seen on several accounts, in an invite email and in a text confirmation becomes **one** event.
- Reschedules move the event and cancellations delete it, whether they come from a calendar change or a later email.
- Each event's description has the join link, the people, and links back to every source email or calendar entry.
- Meetings found only in email text with medium confidence get a `(?)` prefix and are marked tentative.
- Every decision is logged to a Google Sheet. `dryRun()` previews without writing anything.

It's free to run: no servers, no Google Cloud project, no billing. The only cost is the AI model that reads emails, DeepSeek or Claude (your choice): a few dollars to start, then cents a month.

> **Our accounts, who does what and in which order:** [docs/OUR_SETUP.md](docs/OUR_SETUP.md).

---

## How it works

One copy of the same script runs **inside each Google account** as an Apps Script project. Each copy:

1. reads its own account's calendars (next 120 days) and new Gmail threads, every 10 minutes
2. drops obvious noise locally (promotions, newsletters, no date or time mentioned)
3. parses calendar invites (.ics) directly and sends other likely threads to the model (**DeepSeek V4.1 Flash** or **Claude Haiku 5.5**, whichever key you add)
4. merges what it found with everything the other copies wrote, then creates, updates or deletes events

```
 ashoka (R) ─┐
 ashoka (H) ─┤   each runs Code.gs every 10 min      ┌──────────────────────────────┐
 ashoka (A) ─┼── reads only its own mail + calendars ─► "Founders — All Meetings"    │
 founders@  ─┤   writes to the shared calendar        │  (owned by founders@tryamp.in) │
 rc@        ─┘                                        └──────────────────────────────┘
```

**Why this design:**

| Choice | Why |
|---|---|
| A script inside each account, not one central app | No Google Cloud project, no OAuth app, no "unverified app" review. A script running in your own account is also far less likely to be blocked by a Workspace admin (e.g. Ashoka) than an outside app. |
| The shared calendar **is** the shared database | Each event carries its sources in hidden properties. Cancelled meetings are kept as hidden "memory" events dated 1 Jan 2000, so no account re-adds a meeting another account saw cancelled. |
| Dedupe keys, strongest first | iCalUID (the same invite in several accounts) → same email thread → same video-call ID **and** start within 15 min → start within 15 min plus a shared outside attendee or a similar title. |
| Duplicate healing | If two accounts add the same meeting in the same minute, the next run (from any account) merges them. Copies write events in a canonical order, so they never fight over an event. |
| Newest information wins | A later email or calendar change beats an older one. Calendar data wins ties. Moving or cancelling a meeting from email text needs confidence ≥ 0.8. |
| Polling every 10 min | Gmail's `history` API makes polling cheap. Push notifications would need a paid Google Cloud setup. |

**Permissions each copy asks for:** read Gmail (read-only), manage calendars (needed to write to the shared calendar; it only writes there), call external services (Claude), run on a timer, create its log sheet, and know its own email address.

**Limits:** Apps Script gives each account 90 minutes of trigger time a day and 6 minutes per run. A normal run takes a few seconds.

---

## Installing in one account (~5 min)

Do this **signed in as that account**. Use a browser profile or an incognito window that has only that account signed in, because Apps Script gets confused when several Google accounts are signed in.

1. Open <https://script.google.com> → **New project**. Click "Untitled project" and rename it **Founders Meeting Agent**.
2. ⚙ **Project Settings** → tick **Show "appsscript.json" manifest file in editor**.
3. ‹› **Editor**:
   - open `appsscript.json`, select all, and paste the contents of [`dist/appsscript.json`](dist/appsscript.json)
   - open `Code.gs`, select all, and paste the contents of [`dist/Code.gs`](dist/Code.gs)
   - press **⌘S / Ctrl+S**
4. ⚙ **Project Settings → Script properties → Add script property**. Property `DEEPSEEK_API_KEY` (or `ANTHROPIC_API_KEY` to use Claude), value: the key. **Save**.
5. ‹› Editor → function dropdown in the toolbar → **setup** → **Run**. Then **Review permissions** → pick the account. If you see *"Google hasn't verified this app"*, click **Advanced → Go to Founders Meeting Agent (unsafe)**. It's your own script. Click **Allow**.
6. The log at the bottom should say **✅ Setup done**. Run **dryRun** and read what it would add, either in the log or in the "Founders Meeting Agent — Log" sheet in that account's Drive.
7. Run **enableSync**. Done. The first few runs also scan the last 6 months of mail, so older meetings fill in over an hour or two.

**The calendar owner's account goes first.** That's the address in `CONFIG.calendarOwner` at the top of `Code.gs`. Its `setup()` creates the shared calendar and shares it, with edit access, with every other account in `CONFIG.accounts`. Each other account then gets an email, "… shared a calendar with you". Click **Add this calendar** in it *before* running `setup()` in that account. If the email never arrives, add the Script property `SHARED_CALENDAR_ID` with the calendar ID the owner's `setup()` printed; `setup()` then adds the calendar itself.

### Changing who's included

Edit the `CONFIG` block at the top of `src/Config.js`, then run `npm run bundle` to regenerate `dist/Code.gs`:

- **`accounts`**: every address that runs a copy, with its tag. Use `R`, `H` or `A` for a founder's own inbox, and `R+H+A` for shared team inboxes like founders@, whose meetings belong to everyone.
- **`founders`**: names, plus the address each founder uses on their phone (the first one listed).

To add an account: add it to `CONFIG.accounts` and re-paste `Code.gs` in the owner's copy, then run `setup()` there again so the new account gets shared. Then install in the new account.

To remove an account: in that account's copy, run **removeThisAccount**. That stops its sync and removes upcoming meetings only it knew about. Then delete the project.

### Updating the code later

Re-paste `dist/Code.gs` into each copy and save. Settings, cursors and the calendar are kept. There's no need to run `setup()` again.

## Dry run and logs

- `dryRun()` is safe at any time: it reads all calendars plus the last 14 days of matching mail and shows what would change. Nothing is written and no cursors move. You can change the window with the `DRY_RUN_DAYS` and `DRY_RUN_MAX_THREADS` script properties.
- **Log sheet** (one per account, in its Drive): *Time, Mode (LIVE/DRY), Action, Who, Title, When, Confidence, Reason, Source link, Meeting id*.
  - **Actions:** `create`, `update`, `delete`, `tomb` (cancellation remembered), `skip` (low confidence, past, stale), `detected` (dry run), `error`, `note`, plus one `run` summary row per sync.
  - **Reason** tells you why. For example: *"email in hardik…@school.example (confidence 0.92): 'Friday 11am works'"*.
- **showStatus()** prints last sync time, backfill progress, and whether the timer is on. Apps Script's **Executions** page shows each run's log.

## If something is blocked

- **"… can only view the shared calendar"** or the share email never arrives: the owner's domain only allows sharing free/busy outside the organisation. In the owner domain's Admin console go to *Apps → Google Workspace → Calendar → Sharing settings → External sharing options for secondary calendars* and choose **Share all information, and outsiders can change calendars**. Then run `setup()` again in the owner's account.
- **"This app is blocked" / "admin_policy_enforced"** when authorizing: the account's Workspace admin restricts Apps Script or Gmail access. Ask IT to allow Apps Script for your account. The request template is in [docs/OUR_SETUP.md](docs/OUR_SETUP.md).
- **"Exception: … UrlFetchApp"**: the admin blocks scripts from calling outside services, so Claude can't be reached. Same fix: ask IT.

## Phone: widget + reminders (no custom app needed)

The native Google Calendar apps already do this. Each person sets their own reminder defaults for the shared calendar, and both iOS and Android have home-screen widgets.

**Everyone, once, on a computer:** open <https://calendar.google.com> in the account you use on your phone. Hover *Founders — All Meetings* → **⋮ → Settings and sharing → Event notifications** → add **30 minutes** and **10 minutes**. This syncs to the phone apps. The agent creates events with "default reminders", so these apply to every meeting.

**iPhone:**

1. Install **Google Calendar** and sign in with that account.
2. ☰ → make sure **Founders — All Meetings** is ticked.
3. iOS **Settings → Notifications → Google Calendar** → Allow.
4. To check: Google Calendar → ☰ → ⚙ → your account → *Founders — All Meetings* → **Default notifications** should show 30 and 10 minutes.
5. Widget: long-press the home screen → **+** → **Google Calendar** → **Up next** or **Schedule** → Add Widget. Lock-screen widgets work the same way under *Customize → Lock Screen*.

Apple Calendar also works (Settings → Calendar → Accounts → add Google, then tick the calendar at <https://calendar.google.com/calendar/syncselect>). It may not reproduce Google's per-calendar alerts reliably, so prefer the Google app.

**Android:**

1. **Google Calendar** → ☰ → tick **Founders — All Meetings**. If it's missing: ☰ → Settings → the account → the calendar → **Sync** on.
2. ☰ → Settings → *Founders — All Meetings* → **Default notifications** → 30 min and 10 min.
3. Android Settings → Apps → Calendar → Notifications on. On Xiaomi, OnePlus and similar phones, also set battery to *No restrictions*.
4. Widget: long-press the home screen → **Widgets** → **Calendar** → **Schedule** → drag onto the home screen.

## Settings (Script properties, all optional except the key)

| Property | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | | From <https://platform.deepseek.com/api_keys>. Set this **or** the Claude key |
| `ANTHROPIC_API_KEY` | | From <https://console.anthropic.com> → API keys |
| `PROVIDER` | (whichever key is set; Claude if both) | `deepseek` or `anthropic` |
| `MODEL` | `deepseek-flash` / `claude-haiku-5-5` | Model used for extraction |
| `DEFAULT_TZ` | `Asia/Kolkata` | Timezone when an email doesn't say one |
| `ADD_THRESHOLD` | `0.8` | At or above: added normally. Also the minimum for moving or cancelling from email |
| `TENTATIVE_THRESHOLD` | `0.6` | From here up to `ADD_THRESHOLD`: added as `(?)` tentative. Below: logged only |
| `DEFAULT_DURATION_MIN` | `30` | Length when no end time is given |
| `BACKFILL_MONTHS` | `6` | How far back the first scan goes |
| `LOOKAHEAD_DAYS` | `120` | How far ahead calendars are read |
| `INCLUDE_ALL_DAY` | `false` | Also copy all-day events |
| `DRY_RUN_DAYS` / `DRY_RUN_MAX_THREADS` | `14` / `40` | Dry-run window |

Written by the script, don't edit: `SHARED_CALENDAR_ID`, `LOG_SHEET_ID`, `SELF`, `BATCHES`.

## Costs

- **Google:** free.
- **DeepSeek V4.1 Flash** (`deepseek-flash`, $0.15 / $0.60 per million input / output tokens off-peak, double during peak hours 01:00–04:00 and 06:00–10:00 UTC on weekdays). It has no batch discount, so the backfill calls it directly:
  - Backfill: about **$1.50–$4 total** across the five accounts.
  - After that: about **$0.30–$1 a month**.
- **Claude Haiku 5.5** ($0.10 / $0.50 per million tokens, backfill at half price through the Batch API): about **$0.50–$1** to start, then **$0.10–$0.30 a month**.
- **Privacy:** only threads that pass the local prefilter are sent to the model provider, and only to extract date and time. DeepSeek processes data in China; Anthropic in the US. Shared-calendar events show full details to everyone with access.
- To switch provider later, add the other key and set `PROVIDER`. Nothing else changes.

## Development

```bash
npm test
```

This rebuilds `dist/` and runs 45 offline tests: prefilter, .ics parsing, extraction parsing, dedupe/reschedule/cancel, duplicate healing, and a simulation of all five accounts running the real `dist/Code.gs` against one fake shared calendar (setup, dry run, sync, races, cancellations, removal).

The sample emails in `tests/fixtures/` are:

- confirmed meeting
- vague proposal
- reschedule
- cancellation
- accelerator slot with a relative date
- Calendly booking
- newsletter
- one invite duplicated across two founders' accounts

To run those through the real model (costs well under $0.01):

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run eval:live
```

```
src/Config.js      CONFIG: accounts, tags, calendar owner  ← edit this
src/core/          pure logic (shared with tests): Prefilter, Ics, Sources, Extract, Reconcile, Render, Settings, Links, Util
src/               Apps Script side: Sync (syncAll, dryRun), Backfill, Setup, SharedStore, GmailApi, CalApi, Claude, AgentLog, Self
dist/Code.gs       everything in one file, to paste into each account (built by npm run bundle)
```

## Known limitations

- A reschedule sent in a *new* thread, with no shared outside attendee and a different title, can show up as a second event. It's logged, and you can delete the old one by hand.
- Recurring meetings are taken from calendars (each instance becomes an event). Recurring invites that only exist as emails are skipped.
- Only calendars each account *owns* are read. Subscribed calendars (holidays, colleagues) are ignored.
- Hand edits to agent-made events on the shared calendar are overwritten on the next change. Delete-by-hand works.
