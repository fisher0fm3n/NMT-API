# Command and Control Performance System API

App-facing API for the **New Media Ministries** Command and Control Performance
System, served by this Express app from `routes/nmm.js`. It reads and writes the same `nmm_reporting` Postgres
database as the web dashboard (`staff-reporting-web`), with the same rules, so
anything filed in the app appears on the web immediately and vice versa.

All paths are prefixed with `/nmm`.

## The model in one paragraph

Every user belongs to a **directorate**, a **flagship institution**, or both.
Each of those is a *unit* and each unit gets its own reports. A month has four
report slots per unit: **Week 1, 2 and 3 Reports** (days 1–7, 8–14, 15–21) and
the **Month's Report** (day 22 to month end). Before the first report of a month
can be submitted, the user must set **monthly goals** for that unit; they tick
those goals off as the weeks go by. Reporting opens on **August 2026**
(`REPORTING_START_PERIOD`): every month from then up to the current one stays
open, so missed reports can still be filed. The Month's Report, once submitted,
stays editable for **24 hours** and then becomes final. Deadlines are judged in
`Africa/Lagos` time.

## Authentication

| Header | Purpose |
| --- | --- |
| `x-api-key` | The app key. Required on every `/nmm/*` call. |
| `Authorization: Bearer <token>` | The signed-in user. Required on everything except `/nmm/ping`, `/nmm/units` and the sign-in call. |

```
POST /nmm/auth/kingschat        { "code": "<authCode from KingsChat>" }
```

The app opens `https://accounts.kingschat.online/log-in?clientId=630166b6-6431-4239-8036-c40b1b0f2652&redirect_uri=<your redirect>`,
receives an `authCode`, and posts it here. An existing KingsChat `accessToken`
may be sent instead of `code`. The response carries the bearer token, the user,
and `next`, which tells the app what to show:

| `next` | Meaning |
| --- | --- |
| `onboarding` | Head: collect full name, role and directorate / institution → `POST /nmm/onboarding`. Also returned for an approved account with no unit yet. |
| `onboarding_staff` | Staff who joined via an invite: collect the profile → `POST /nmm/onboarding/staff`. |
| `pending` | Waiting for an administrator to approve. Poll `/nmm/me`. |
| `rejected` | The request was declined. |
| `disabled` | The user switched their own account off. Offer to switch it back on via `POST /nmm/account`. |
| `home` | Approved. Full access. |

Tokens last 30 days (`NMM_SESSION_DAYS`). `POST /nmm/auth/logout` revokes one.

When `next` is `rejected` (application declined) or `removed` (access taken away
after approval), show wording that matches and offer to acknowledge it:
`POST /nmm/account/withdraw` deletes the account, its KPIs and its sessions, so
the person can sign in again and register afresh. It returns `not_closed` (409)
for any other status.

## Response shape and error codes

Success is `{ "status": true, … }`. Failure is
`{ "status": false, "error": "<code>", "message": "<human readable>" }`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `unauthorized_api_key` | 401 | Bad or missing `x-api-key`. |
| `no_token` / `invalid_token` | 401 | Not signed in or session expired. Sign in again. |
| `onboarding_required` | 403 | Send the user to onboarding. |
| `approval_required` | 403 | Account not approved yet. |
| `forbidden` | 403 | Not the owner, or not a super admin. |
| `not_open` | 409 | That week has not arrived, or its month is before the reporting start month. |
| `report_locked` | 409 | Past the edit window; the report cannot change. |
| `period_closed` | 409 | Goals for a month outside the open range cannot change. |
| `validation_failed` | 422 | Submission rejected; `message` lists why. |
| `upload_error` | 400/413 | File too large or type not allowed. |

## Account

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/nmm/account` | `{ action: "disable" }` switches the caller's own account off (ends every session) and `{ action: "reactivate" }` switches it back on. Returns `last_super_admin` (409) if that would leave nobody able to administer. |
| `DELETE` | `/nmm/account` | Deletes the caller's own account, KPIs, goals, reports and attachments for good. |
| `GET` | `/nmm/me` | User, `next`, `units` — the `{ id, kind, name }` list the caller heads — and `scopes`, what they may actually file: `{ ownerId, unitId, kind, unitName, onBehalfOf }`. For a delegate `units` is empty and `scopes` holds their head's unit. |
| `PATCH` | `/nmm/me` | `{ fullName, phone }`. The only self-service fields. |
| `GET` | `/nmm/units` | Active `directorates`, `institutions` and the selectable `roles`. Needs a signed-in token. |
| `POST` | `/nmm/onboarding` | `{ fullName, role, directorateId?, institutionId? }` — at least one of the two ids. |

`role` is one of `director`, `assistant_director`, `assistant`. These are titles;
`super_admin` (granted by an admin) and `staff` (from an invite link) change what
a user can do.

## Staff and invite links

A head shares a link so their team can join. `GET /nmm/staff/invites` returns one
ready-made link per unit they head (`{ unit, url, token, uses }`); the link is
`<site>/join/<token>`.

An app that opens such a link keeps the token, signs the person in, then calls
`POST /nmm/invites/accept` with `{ token }`. That attaches a brand-new account to
the unit as **staff**; existing heads are left untouched (`applied: false`).

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/nmm/invites/accept` | `{ token }` → attaches the signed-in new account as staff. |
| `POST` | `/nmm/onboarding/staff` | `{ fullName, birthday (YYYY-MM-DD), rank, staffRole, city, country, phone?, kpis: [{ kpi, target }] }`. At least one KPI. |
| `GET` / `PUT` | `/nmm/kpis` | A staff member reads / replaces their own KPI list. |
| `GET` | `/nmm/staff/invites` | Heads only. The link per unit. |
| `GET` | `/nmm/staff` | Heads only. Their staff with rank, role, location, birthday and KPI count. |
| `GET` | `/nmm/staff/:id` | One staff member in full: profile fields plus KPIs. Head of that unit, or a super admin. |
| `PATCH` | `/nmm/staff/:id` | Heads only. `{ status?: "approved" \| "rejected" \| "removed", canReport?: boolean }`. |

Staff accounts do not file reports or set goals: `/nmm/home`, `/nmm/goals`,
`/nmm/reports*` and `/nmm/periods` return `forbidden` for them.

## Home

```
GET /nmm/home?period=YYYY-MM         (period defaults to the current month)
```

One entry per unit the user reports for, ready to render the dashboard:

```json
{
  "status": true, "period": "2026-09", "currentWeek": 1,
  "units": [{
    "unit": { "id": 3, "kind": "directorate", "name": "Directorate of Technology & Digital Innovation" },
    "goals": { "total": 2, "done": 0 },
    "weeks": [
      { "week": 1, "label": "Week 1 Report",  "status": "submitted", "reportId": 1, "submitted_at": "…" },
      { "week": 2, "label": "Week 2 Report",  "status": "upcoming",  "reportId": null },
      { "week": 3, "label": "Week 3 Report",  "status": "upcoming",  "reportId": null },
      { "week": 4, "label": "Month's Report", "status": "upcoming",  "reportId": null }
    ],
    "missed": 0, "currentWeek": 1, "monthOpen": true
  }]
}
```

Week `status` values: `submitted`, `draft`, `due` (this week, not started),
`missed` (a past week with no submission — still fillable while the month
runs), `upcoming`. Show `goals.total === 0` as a "set your goals" prompt, and
`missed > 0` as a warning.

## Goals

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/nmm/goals?kind=&period=` | The list plus `editable`. |
| `PUT` | `/nmm/goals` | `{ kind, period, goals: [{ id, goal, intended_outcome, target_date }] }`. Replaces the list; keep `id` on existing goals so their ticks survive. Current month only. |
| `PATCH` | `/nmm/goals/:id` | `{ completed: true }`. Current month only. |

## Reports

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/nmm/reports?kind=` | History for one unit, newest first. |
| `POST` | `/nmm/reports` | `{ kind, period, week }` → opens (creates if needed) that report. Any month from the reporting start month to the current one; in the current month, only weeks that have arrived. 409 `not_open` otherwise. Returns the report and the month's goals. |
| `GET` | `/nmm/reports/:id` | Full report + goals. Owner or super admin. |
| `PUT` | `/nmm/reports/:id` | Save sections. Allowed while `window.canEdit`, even after submission. |
| `POST` | `/nmm/reports/:id/submit` | Requires goals for the month and at least one highlight. |
| `DELETE` | `/nmm/reports/:id` | Drafts only, while the window is open. |
| `GET` | `/nmm/periods` | Months with reports, plus `open` (every month still fillable, newest first), `start` (the reporting start month), `current` and `currentWeek`. |

### Sections

A **weekly report** (weeks 1–3) carries `highlights` only:
`[{ id, activity, purpose, status_impact }]` — what was done, why, and the impact.

The **Month's Report** (week 4) carries the full OFEM form:

| Field | Section | Row shape |
| --- | --- | --- |
| goals (read via the report's `goals`) | 1. Goals for the month | ticked through `/nmm/goals/:id` |
| `platforms` | 2. Digital Platforms | `{ id, platform, purpose, hosted_on, status }` |
| `highlights` | 3. Reports and Highlights | `{ id, activity, purpose, status_impact }` |
| `relations` | 4. Inter-Ministerial Relations | `{ id, activity, overlap, collaboration, suggestions }` |

`PUT` replaces each section with what you send. Rows with every field blank are dropped.

### Derived fields

`head_of_unit` (the user's full name), `submission_date` (stamped on first
submission, Lagos date) and the unit itself are set by the server. Anything
sent for them is ignored.

### The edit window

Every report carries `window`:

```json
"window": { "canEdit": true, "reason": "month", "until": "2026-10-01T00:00:00.000Z" }
```

| `reason` | Meaning |
| --- | --- |
| `month` | The current month. Editable until it ends. |
| `catch_up` | An earlier month that is still open, so what was missed can be filed. `until` is `null`. |
| `grace` | A submitted Month's Report, inside its 24-hour window. `until` is the deadline. |
| `unlocked` | A super admin reopened it until `until`. |
| `closed` | Final. Every write returns `report_locked`. |

Use `window.canEdit` to decide whether to show Save / Submit controls.

### Attachments

```
POST   /nmm/reports/:id/attachments     multipart, field `files` (repeat for several; 10 per request, 25 MB each)
GET    /nmm/attachments/:id             streams the file (?download=1 forces a save)
DELETE /nmm/attachments/:id
```

Both writes follow the report's edit window.

## Staff

Staff join through a unit's invite link. The app captures the token from a
`/join/<token>` URL and posts it after sign-in.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/nmm/invites/accept` | `{ token }` — attaches a brand-new account to that unit as staff. Existing heads are untouched. |
| `POST` | `/nmm/onboarding/staff` | `{ fullName, birthday, rank, staffRole, city, country, phone?, kpis: [{ kpi, target }] }`. At least one KPI. |
| `GET` / `PUT` | `/nmm/kpis` | The signed-in staff member's own KPIs. |
| `GET` | `/nmm/staff/invites` | Heads: the ready-made link per unit they head. |
| `GET` | `/nmm/staff` | Heads: their staff, with status and KPI counts. |
| `GET` | `/nmm/staff/:id` | One staff member in full: profile fields plus KPIs. |
| `PATCH` | `/nmm/staff/:id` | `{ status?, canReport? }`, either or both. `status` is `approved` / `rejected` / `removed` — **the head of the unit approves, declines or removes their own staff**; super admins may too. `canReport` delegates reporting (below). |

Staff accounts have `role: "staff"` and a `staffUnitId`. By default they do not
file reports: `/nmm/home`, `/nmm/goals`, `/nmm/reports` and `/nmm/periods`
return 403 `forbidden` for them.

### Delegated reporting

A head can let chosen staff help complete their unit's monthly goals and
reports. `PATCH /nmm/staff/:id` with `{ "canReport": true }` sets that staff
member's `reportsForId` to the head; `false` clears it. Only the head of the
staff member's own unit can grant it, and only for an approved staff member — a
super admin who does not head that unit gets 403. Declining or removing a staff
member clears the delegation automatically.

A delegate then gets `/nmm/home`, `/nmm/goals` and `/nmm/reports` for that one
unit, and everything they file belongs to the **head**: `report.user_id` is the
head's id and `head_of_unit` is the head's name. Responses carry
`onBehalfOf: "<head's name>"` so the app can say whose report is being filled
in. Delegation does not open anything else — `/nmm/staff*` and the invite links
stay 403 for staff accounts.

## Admin (super admin only)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/nmm/admin/users` | `?status=new\|pending\|approved\|rejected`. Includes both unit names. |
| `PATCH` | `/nmm/admin/users/:id` | `{ status, role, directorateId, institutionId }`, any subset. |
| `GET` / `POST` | `/nmm/admin/units` | List all (including inactive) / add `{ kind, name }`. |
| `PATCH` | `/nmm/admin/units/:id` | `{ name, isActive }`. |
| `GET` | `/nmm/admin/reports` | `?period=&kind=&unit=&week=&status=`. |
| `GET` | `/nmm/admin/overview` | `?period=` → per-unit members, weekly submitted / expected, month's reports, goal progress, totals, pending approvals. |
| `POST` | `/nmm/admin/reports/:id/unlock` | `{ hours }` (default 48). Reopens a locked report. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NMM_DATABASE_URL` | – | Connection string for `nmm_reporting`. When set, the `NMM_DB_*` fields are ignored. |
| `NMM_DB_HOST` / `NMM_DB_NAME` / `NMM_DB_USER` / `NMM_DB_PASSWORD` / `NMM_DB_PORT` | `102.219.189.166` / `nmm_reporting` / `postgres` / `PCO_FN_DB_PASSWORD` / `5432` | Used when no connection string is set. |
| `NMM_API_KEY` | falls back to `GENERAL_API_KEY` | The `x-api-key` value. |
| `NMM_KC_CLIENT_ID` | `630166b6-6431-4239-8036-c40b1b0f2652` | KingsChat OAuth client id. |
| `NMM_REPORTING_TIMEZONE` | `Africa/Lagos` | Clock used for week boundaries, month ends and submission dates. Keep equal to the web app's `REPORTING_TIMEZONE`. |
| `NMM_MONTHLY_EDIT_GRACE_HOURS` | `24` | Edit window after submitting the Month's Report. |
| `NMM_UPLOAD_DIR` | `<cwd>/uploads/nmm` | **Must match the web app's `UPLOAD_DIR`** to share attachments. |
| `NMM_MAX_UPLOAD_MB` | `25` | Per-file limit. |
| `NMM_SESSION_DAYS` | `30` | Token lifetime. |
| `NMM_SUPER_ADMIN_KC_USERNAMES` | – | Usernames auto-approved as super admins on first sign-in. |

The schema is owned by the web app: run `npm run db:migrate` there. This API
never creates or alters tables.

## Security

Every `/nmm` route needs the app key; everything except `/nmm/ping` and the
sign-in call also needs a user bearer token. Identity always comes from that
token — no endpoint accepts a user id as identity. Responses are sent
`no-store`. Authorisation is per resource: for reports and goals, the owner or a
staff member the owner has delegated to (`canReport`); the head of the unit for
staff; super admin for `/nmm/admin/*`.

```
GET /nmm/ping   →  { "status": true, "message": "nmm reporting api alive", "units": 12, "period": "2026-09", "week": 1 }
```

Set `NMM_SITE_URL` to the web app's public URL so `/nmm/staff/invites` returns
complete `https://…/join/<token>` links.
