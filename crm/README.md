# TGS CRM

A CRM for a BPO: **Company → Contact → Deal**, with a multi-channel outreach engine
(LinkedIn, email, cold calling) feeding the pipeline.

Outreach sequences generate the meeting; deals track the money from there. Contacts walk
through campaign stages, each carrying its own message or script; a booked meeting creates
the deal automatically.

React + Vite client, Express server, MongoDB. Same shape as `tgs-training-platform`, so it
deploys to Railway on infrastructure you already run.

---

## Quick start

```bash
cd crm
npm run install:all
cp .env.example .env      # then edit MONGODB_URI and JWT_SECRET
npm run dev
```

- Client: <http://localhost:5174>
- API: <http://localhost:3002>
- First login: `admin@tgsbpo.com` / `Admin@123` — you are prompted to change it.

**Upgrading from the outreach-only version?** Run the migration once, before starting the app:

```bash
node server/scripts/migrate-to-companies.js --dry-run   # report only
node server/scripts/migrate-to-companies.js             # apply
```

It turns every lead into a Contact, deduplicates the free-text company field into real
Company records by email domain, and renames the `lead` reference on every enrollment, task,
draft and activity. Record ids are preserved, so nothing can be orphaned by a partial run.
The old collection is kept as `leads_migrated_backup` rather than dropped.

Ports avoid the rest of the workspace (5173 and 3001 belong to the other projects).

```bash
npm test
```

Boots a throwaway in-memory MongoDB and drives the real HTTP API end to end — 323 checks,
no database or mail server required. The first run downloads a MongoDB binary (~80MB).

---

## The object model

| Object | Holds | Visibility |
|---|---|---|
| **Company** | The buying organisation. Qualification lives here — seats needed, target roles, current provider, contract timing — so every contact there shares it, and a new deal prefills from it. | Everyone |
| **Contact** | A person, belonging to a company. Status is a **lifecycle** only: New → Contacted → Engaged → Meeting Booked → Qualified → Customer → Nurture → Do Not Contact. | Owner only |
| **Deal** | Revenue. The only object that owns **Won** and **Lost**. | Everyone sees; owner edits |

Companies are matched on **email domain** first, name second — two people typing "Acme Health"
and "Acme Health Inc." land on the same record because both have `@acmehealth.com` addresses.
Free mailboxes (gmail, outlook, …) never become companies.

**Contacts have no Won or Lost.** Two objects both claiming to say whether you won will
disagree, and then no report can be trusted. Winning a deal sets its contacts to Customer.

---

## Deals, money and forecasting

A deal belongs to a company, involves one or more contacts, and sits in exactly one pipeline
stage. Won and Lost are stages with a terminal type, not a separate field.

**Default pipeline** (rename freely in Settings → Pipeline, each with its own win probability):
Discovery 10% → Scoping 25% → Proposal Sent 50% → Pilot 70% → Contract 90% → Won / Lost.

### MRR is not TCV

Two numbers, and confusing them is how a forecast ends up wrong by an order of magnitude:

- **MRR** — recurring monthly revenue (seats × rate, hours × rate)
- **TCV** — total contract value = MRR × term + one-off fees

Both are stored on every deal, and every report says which it is using. Price a deal as one
number or itemise it: a line is per-seat monthly, a one-off fee, per hour, or per unit.
Hourly and per-unit lines are treated as **monthly volume** — a BPO hourly contract bills
every month.

### Multi-currency

USD, PHP, GBP, AUD, EUR and CAD out of the box; add more in Settings. Rates are maintained by
hand — there is no live feed, and pretending otherwise would be worse than being explicit.

The rate is **stamped onto the deal when it is saved**, so updating the rate table changes
future deals and leaves historical numbers alone. Last quarter's reported figures should not
move because the peso did.

### Forecast

Two numbers, read together rather than instead of each other:

- **Weighted** — value × stage probability, excluding Omitted. The statistical view.
- **Commit / Best case / Pipeline / Omitted** — what the rep will actually stand behind.

A stage probability on its own is reliably optimistic, which is why both exist.

Losing a deal **requires a reason**. A loss with no reason tells you nothing later, and the
lost-deal report is nothing but those reasons.

### Outreach hands off to pipeline automatically

Logging a **Meeting Booked** call outcome, or setting a contact to Meeting Booked, creates a
draft deal at stage 1 on that company — prefilled from its seats needed and target roles. A
second meeting on a company that already has an open deal does **not** create a second deal.

---

## How the campaign engine works

A **campaign** is an ordered list of **stages**. Every stage has a channel, a message or
script, and a wait in days.

```
Stage 1  LinkedIn connect   wait 3d
Stage 2  Intro email        wait 4d
Stage 3  Cold call          wait 3d
Stage 4  LinkedIn follow-up wait 7d
```

When a lead enters a stage, the CRM immediately produces the work for it:

| Stage channel | What is produced | Who acts |
|---|---|---|
| **LinkedIn** | A task with the message merged and ready to copy | Rep, by hand in LinkedIn |
| **Email** | A draft in **Ready to Send** | Rep reviews, then clicks send |
| **Call** | A call task with the script, listed in the timezone-aware call list | Rep dials |

When the stage's wait elapses, a **server-side scheduler advances the lead automatically**
(default every 15 minutes — `SCHEDULER_CRON`). It runs on the server, not on page load, so
leads move whether or not anyone has the app open.

Anything still unfinished for the stage being left is **retired**: pending tasks are marked
skipped and unsent drafts are cancelled, both recorded on the lead's timeline. A first-touch
email arriving after the second touch is worse than none at all.

### Email is never sent without a person

An email stage produces a *draft*, never a send. Nothing leaves the building until someone
opens **Ready to Send**, reads it, and clicks send. This catches broken merge fields and
wrong-lead mistakes while they are still cheap.

If sending fails because SMTP or compliance settings are incomplete, the draft **stays
queued** and is retried once you fix the setting — a configuration mistake never burns a draft.

### LinkedIn is never automated

There is no LinkedIn send path anywhere in this codebase. LinkedIn has no legitimate
messaging API for outreach and automating it gets accounts restricted. The CRM stores the
profile URL, merges the message, and opens the profile so the rep sends it themselves.

---

## Compliance

Cold email carries legal obligations (CAN-SPAM, GDPR, the Philippine Data Privacy Act).
These are enforced, not suggested:

- **Sending is blocked entirely** until a physical postal address and an app base URL are
  set in Settings → Company & compliance.
- Every outgoing email gets your company name, postal address and a working unsubscribe
  link appended **at send time** — it cannot be edited out of a template.
- A `List-Unsubscribe` header (RFC 8058) enables one-click opt-out in mail clients.
- The **do-not-contact list** is checked twice: when a draft is queued and again in the
  moment before the SMTP handoff, because a lead can opt out in between.
- Suppression accepts a single address, a whole domain, or a LinkedIn URL. Adding one flags
  every matching lead and cancels their work in flight.
- Unsubscribing exits every active campaign and cancels all pending work for that lead.

---

## Users and access rights

An admin adds people under **Settings → Users & access** and decides what each one can do.

### Roles are a starting point, not a cage

| | Admin | Manager | Rep | Read-only |
|---|:--:|:--:|:--:|:--:|
| See everyone's contacts | ✓ | ✓ | — | ✓ |
| Create and edit contacts | ✓ | ✓ | ✓ | — |
| Import / export CSV | ✓ | ✓ | — | — |
| Delete and merge records | ✓ | ✓ | — | — |
| Edit anyone's deal | ✓ | ✓ | — | — |
| Approve quotes | ✓ | ✓ | — | — |
| Edit the rate card | ✓ | — | — | — |
| Build campaigns | ✓ | ✓ | — | — |
| Team-wide reports | ✓ | ✓ | — | ✓ |
| Settings | ✓ | — | — | — |
| Users and access | ✓ | — | — | — |

Any single right can be switched on or off **for one person** on top of their role, so a team
lead who should also be able to edit the rate card does not have to become a full admin. The
screen shows which rights came from the role and which were changed for that person.

**Read-only sees everything and changes nothing** — that is the point. A read-only account that
showed an empty contact list would be no-access wearing the wrong label.

### What stops this being a way in

- **You cannot grant a right you do not hold yourself.** A manager with user-management cannot
  quietly give themselves — or anyone else — the ability to change settings.
- **You cannot change your own role or permissions.** Ask another admin. This is the rule that
  stops a permissions system being walked around from the inside.
- **The last active admin cannot be demoted or deactivated**, or the account would lock itself
  out of its own settings.
- Changes take effect on the person's **next request**. Nobody keeps a right because they have
  not signed out.

Every route is guarded on the server. Hiding a button is a courtesy so people do not click
things that will fail — it is not the security boundary.

### Removing someone

Deactivating, not deleting. A deleted user would orphan every contact, deal and activity they
own, so the account is switched off and keeps its name on the records. It tells you how much
they still own, so you can reassign first if someone else should pick it up.

---

## Products and quotes## Products and quotes

### The rate card

A **product** is a thing you sell at a price. Each one picks its own pricing basis:

| Basis | Quoted quantity is | Counts toward |
|---|---|---|
| Per seat / month | seats | MRR |
| Per hour | estimated hours **per month** | MRR |
| Per unit | estimated units **per month** | MRR |
| One-off fee | a count | contract value only, never MRR |

Hourly and per-unit are monthly volume on purpose — a BPO hourly contract bills every month.

Each product carries a **list price**, an optional **floor price**, and an optional **unit cost**.
The floor is the margin guard: a 5% cut off an already-thin rate can hurt more than 20% off a
fat one, so a percentage threshold alone does not protect you. Cost is never shown to a client —
it only drives the margin figure a rep and an approver see.

### Quotes

Built from a deal, so anything already priced there carries over. Three rules shape the whole
thing:

1. **A quote line is a snapshot.** Prices are copied at build time. A rate card change next
   month cannot rewrite what a client is looking at.
2. **A quote that has left the building is never edited in place.** Changing one creates a new
   **version** that supersedes it, and the old version's public link stops working. What was
   accepted is exactly what was seen.
3. **Approval is evaluated from the quote's own numbers**, not from what the rep says.

### Approval

A quote that breaks **none** of the active rules is approved the moment it is submitted — there
is no reason to make an admin rubber-stamp something that breaks no rule. A quote that breaks
any of them cannot be shared, and **its public link stays dead until an admin clears it.**

Each rule switches on and off independently in Settings → Quote approvals:

| Rule | Fires when |
|---|---|
| Any discount at all | any line is priced below its list price |
| Discount above a percentage | the largest discount exceeds your limit |
| Priced below the floor rate | any line falls under its product's floor |
| Contract value above a threshold | TCV, converted to the reporting currency, exceeds it |
| Term shorter than a minimum | the contract is too short to recover setup cost |

Rejecting **requires a note** — the rep has to know what to change. Editing a rejected quote
puts it back into draft so it can be resubmitted.

### Sending, and what happens next

The CRM produces a branded **PDF** and a **public link**. You send them yourself — by email,
WhatsApp, however you normally reach the client. The CRM does not email quotes.

The public page shows the itemised pricing, the totals, a PDF download, and Accept / Decline.
Accepting records the name, timestamp and IP, and **rewrites the deal to match exactly what the
client agreed to** — so the pipeline stops carrying whatever the rep guessed before quoting.
Declining captures a reason.

Opening the link is logged once, so a rep can tell "they haven't looked at it" from
"they looked and went quiet" — two very different follow-ups.

---

## Custom fields

An admin adds fields to contacts, companies and deals from Settings → Custom fields, with no
deploy. Text, long text, number, currency, date, dropdown, multi-select, checkbox, link — plus
**calculated** fields.

A calculated field does arithmetic over other number fields:

```
round(({tcv} - {delivery_cost}) / {tcv} * 100, 1)
```

It is a small purpose-built parser, **not** `eval` — an admin typing into a settings box must
never be able to execute code on the server. Functions are `round`, `abs`, `min`, `max` and
`coalesce`; anything else is rejected while they type, with the reason.

Calculated values are never stored. They are worked out fresh on every read, so editing a
formula updates every record at once instead of leaving stale numbers behind. A calculation
over a field nobody has filled in shows as **—**, not zero, and a division by zero is unknown
rather than infinity.

Two things are deliberately refused once a field exists:

- **Renaming its key.** Values are stored under it; renaming would orphan every one, silently.
- **Changing its type while records hold values**, for the same reason. The label can always change.

### Required, and required from a stage onwards

A deal field can be required from a given pipeline stage. The deal then **cannot move to that
stage or past it** until the field is filled — enforced on the server, not just hidden in the
form. Marking a deal **lost** is always exempt: demanding paperwork to record a loss just means
losses go unrecorded.

---

## Saved views

Filter a list the way you like it and save it as a named view. Sharing and pinning are separate
on purpose:

- **Shared** makes it available to the team.
- **Pinned** puts it in *your* tab strip.

So one person tidying their own tabs never rearranges a colleague's. Someone else's view can be
copied into your own if you want to change it.

---

## Duplicates and merging

A scan groups records that look like the same thing twice, ranked by how sure it is:

| | Contacts | Companies |
|---|---|---|
| **Certain** | identical email or LinkedIn URL | shared email domain |
| **Likely** | same name at the same company | names match ignoring punctuation and Inc/Ltd |
| **Possible** | same name, no company to compare | — |

Merging is the one action in the CRM with **no undo**, so it is deliberately awkward: a preview
shows exactly what gets filled, what gets discarded, and what moves across, and you have to type
`merge` to confirm. Admin only.

The rules:

- The survivor's filled fields always win. The loser only fills blanks.
- Everything attached moves. Nothing is deleted except the loser.
- **Suppression is OR-ed, never lost.** If either record said do-not-contact, the merged record
  does too — losing that in a merge is a compliance breach, not an inconvenience.
- The whole merge is written to the survivor's timeline, with what came from where.

Email and LinkedIn URL carry unique indexes, so the loser is removed before the survivor is
written. MongoDB transactions need a replica set, which a single local mongod is not, so a
failed write puts the loser back verbatim rather than losing it.

---

## Dashboard

A per-user home screen assembled from a widget library: my work, forecast, pipeline by stage,
my deals, going quiet, quotes, recent wins, channel performance, leaderboard, activity trend,
neglected contacts, and your calendar.

Only the widgets in your layout are computed — a library of twelve where every load runs all
twelve is how a dashboard becomes the slowest screen in the product. One widget failing reports
itself without blanking the rest.

An empty layout means "use the team default", so a new joiner gets a usable screen without
configuring anything. An admin can save their own arrangement as that default.

### Calendar

Paste your Google or Outlook calendar link into Settings → My profile (the whole `<iframe>`
snippet works too) and it appears as a widget. Read-only, no OAuth, and the CRM never sees your
events — which also means it cannot warn about clashes or attach meetings to deals.

Only calendar.google.com and Outlook hosts are accepted. An iframe pointing anywhere is an
arbitrary page rendered inside the app's chrome, which is a convincing place to ask someone for
their password.

---

## Screens

- **Dashboard** — your own arrangement of widgets, or the team default.
- **Duplicates** — find and merge records that are the same thing twice.
- **Quotes** — build, approve, share. A badge counts anything waiting on an approver.
- **Rate card** — what you sell, at what price, with what floor and what margin.
- **Deals** — pipeline board and table. Cards show value, MRR, probability, forecast category
  and how long the deal has sat where it is. Move one with the card's ⋯ menu.
- **Companies** — the account view: everyone you know there, every deal, and one shared timeline.
- **My Day** — the landing page. Overdue, due today, drafts awaiting approval, done today.
  Each row expands to the merged script with everything needed to finish the task.
- **Ready to Send** — the email approval queue, with a pre-send compliance check that tells
  you what will be skipped *before* you click.
- **Call List** — call tasks sorted by who is actually reachable, showing each lead's local
  time and flagging who is inside business hours.
- **Leads** — filterable table, bulk actions, CSV import/export.
- **Campaigns** — stage editor with merge-field help and live preview against a real lead.
- **Board** — kanban by stage. Move a lead with the card's ⋯ menu (or drag it).
- **Reports** — funnel, channel comparison, rep performance, campaign scoreboard.

### Overdue means "due before today began"

Measured in the signed-in user's own timezone. A task created five minutes ago is due *now*,
not late — otherwise every queue would be permanently red.

---

## Merge fields

`{{first_name}}` inserts the value. `{{first_name|there}}` falls back when it is blank, so a
missing value never leaves a hole in the sentence.

Available: `first_name` `last_name` `full_name` `title` `company` `company_size` `industry`
`website` `email` `phone` `location` `linkedin_url` `company_linkedin_url` `current_provider`
`seats_needed` `target_roles` `contract_timing` `budget_range` `source`

Stage preview reports blanks and typos before anything is queued.

---

## Reports

| Report | Answers |
|---|---|
| **Funnel** | Where leads die in one campaign. Step conversion is a true cohort measure — of the leads that *reached* a stage, the share that later reached the next one. "Jumped in" counts leads moved by hand into a stage without passing through the one before it. |
| **Channels** | LinkedIn vs email vs cold call: touches, responses, meetings, touches per meeting. Calls count a Connected / Callback / Meeting disposition as a response; LinkedIn and email count a logged reply. Meetings are attributed to the last touch before the booking. |
| **Reps** | Per rep: touches by channel, leads touched, meetings, conversion, tasks done, overdue. |
| **Scoreboard** | Trend over time plus per-campaign totals. |
| **Pipeline** | Value by stage (weighted shown inside the total, so the gap is visible), median age per stage, win rate by stage *reached* (cohort, from stage history), median sales cycle, and why deals were lost. |
| **Forecast** | Commit vs best case vs weighted vs already-won, by close month. Flags open deals with no close date — they are invisible to every number on the page. |

Reports depend on reps **logging replies** — that is the signal the response rate is built on.

---

## Lead intake

- **CSV import** with column mapping (auto-guessed), duplicate detection on email and
  LinkedIn URL both inside the file and against existing leads, and automatic suppression
  matching so do-not-contact rows are imported already flagged.
- **Manual entry** and **LinkedIn URL paste**.
- **Public web form** — `POST /api/public/leads`, honeypot field, rate limited, round-robin
  assigned. See Settings → System for the payload.

---

## Deploying

One process serves everything — the API, the React app, the public quote pages and the PDFs —
so there is one service to deploy, not two.

```bash
npm run build:all   # installs prod deps, builds the client to client/dist
npm start           # serves API + client on $PORT
```

`railway.json`, `Procfile` and `.nvmrc` are already in this folder, so Railway needs almost no
configuration beyond environment variables.

### Before the first deploy

**This repository has no git remote.** `crm/` lives inside the wider workspace repo alongside
several unrelated projects, so two things follow:

1. Create a remote and push, or Railway has nothing to build from.
2. Set Railway's **Root Directory to `crm`**, or it will try to build the whole workspace.

### Steps

1. **Push the code.**
   ```bash
   gh repo create tgs-crm --private --source . --remote origin --push
   ```
   Pushing the workspace repo also publishes everything else in it. If that is not wanted,
   split `crm/` into its own repository first.

2. **Create the database.** In Railway, add a **MongoDB** service, or use MongoDB Atlas (the
   free tier is enough to start). Copy its connection string.

3. **Create the app service**, pointed at the repo, with **Root Directory = `crm`**.

4. **Set the environment variables** below.

5. **Deploy.** Watch the logs for the generated admin password — it is printed once and never
   again.

6. **Open the app and finish setup:**
   - Sign in and change the admin password.
   - Settings → Company & compliance: postal address and app base URL. **Email sending stays
     blocked until both are filled in.**
   - Settings → Email: SMTP credentials, when you have them.

### Environment variables

| Variable | Required | Notes |
|---|:--:|---|
| `MONGODB_URI` | yes | Connection string from your MongoDB service |
| `JWT_SECRET` | yes | **The server refuses to start without a real one.** Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_BASE_URL` | yes | Your public URL, e.g. `https://crm.tgsbpo.com`. Unsubscribe links and public quote links are built from it — a wrong value means clients cannot open what you send them |
| `PORT` | no | Railway injects this |
| `SEED_ADMIN_EMAIL` | no | Defaults to `admin@tgsbpo.com` |
| `SEED_ADMIN_PASSWORD` | no | Leave unset and a random one is generated and printed to the logs on first boot |
| `PUBLIC_FORM_TOKEN` | no | Shared secret required by the public web form |
| `SCHEDULER_CRON` | no | Stage engine schedule, default `*/15 * * * *` |

There is no default `JWT_SECRET` and no default admin password. A token signed with a secret
that lives in a public repository can be forged by anyone who reads the code, so the server
would rather crash than pretend that is a session.

### Custom domain

Add it in Railway, point the DNS CNAME at the target Railway gives you, then update
`APP_BASE_URL` to match. Quote links already sent out keep working as long as the old host
still resolves.

### Upgrading an existing install

Run the migration once, before the new version serves traffic:

```bash
node server/scripts/migrate-to-companies.js --dry-run
node server/scripts/migrate-to-companies.js
```

It is safe to run twice and keeps the old collection as `leads_migrated_backup`.

### A note on running build:all locally

It installs the server with `--omit=dev`, which removes the test harness. To get tests back:

```bash
npm --prefix server install
```

---

## Data model

| Collection | Holds |
|---|---|
| `User` | Login, role, timezone, personal SMTP |
| `Contact` | A person, their company link, lifecycle status, owner, unsubscribe token |
| `Company` | The buying organisation, its qualification, and the dedupe domain |
| `Deal` | Revenue, pipeline stage, line items, currency and stamped FX rate, stage history |
| `Product` | The rate card: list price, floor price, unit cost, pricing basis |
| `Quote` | Snapshotted lines, approval state and reasons, versions, public token, acceptance record |
| `CustomField` | Admin-defined fields per object, including formulas and stage requirements |
| `SavedView` | A named filter set, shared or private, pinned per user |
| `User` | Login, role, per-user permission overrides, timezone, personal SMTP |
| `Campaign` | Name and its ordered stages (channel, template, wait) |
| `Enrollment` | One lead's run through one campaign, with full stage history |
| `Task` | LinkedIn or call work for a human |
| `OutboxMessage` | The email approval queue |
| `Activity` | Immutable lead timeline |
| `Suppression` | Do-not-contact list |
| `Settings` | Company, compliance, lead statuses, shared SMTP |

A contact may hold **several active enrollments at once**. Moving a contact between campaigns
exits the old enrollments and cancels their pending work — the enrollment rows and every
activity they produced stay on the timeline forever.

Activities are stamped with the contact, the company **and** the deal they concern, so a
company timeline — everything that ever happened with Acme, across every person there — is a
single indexed query rather than a fan-out.

---

## Still to come

Built so far: the object model and migration; deals, pipeline, multi-currency and forecasting;
products, quotes, approval rules and the public accept/decline link; custom fields, saved views,
duplicate merge, per-user dashboards and the calendar embed.

Remaining: **workflow automation, email open/click tracking and file attachments**. Attachments
need S3-compatible storage credentials before they can be built.
