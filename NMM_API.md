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
those goals off as the weeks go by. Reports are editable while the month is
running; the Month's Report, once submitted, stays editable for **24 hours**
and then becomes final. Deadlines are judged in `Africa/Lagos` time.

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
| `home` | Approved. Full access. |

Tokens last 30 days (`NMM_SESSION_DAYS`). `POST /nmm/auth/logout` revokes one.

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
| `not_open` | 409 | That week has not arrived, or its month has ended. |
| `report_locked` | 409 | Past the edit window; the report cannot change. |
| `period_closed` | 409 | Goals for a past month cannot change. |
| `validation_failed` | 422 | Submission rejected; `message` lists why. |
| `upload_error` | 400/413 | File too large or type not allowed. |

## Account

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/nmm/me` | User, `next`, and `units` — the list of `{ id, kind, name }` the user reports for. |
| `PATCH` | `/nmm/me` | `{ fullName, phone }`. The only self-service fields. |
| `GET` | `/nmm/units` | Active `directorates`, `institutions` and the selectable `roles`. No token needed. |
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
| `PATCH` | `/nmm/staff/:id` | Heads only. `{ status: "approved" \| "rejected" }`. |

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
| `POST` | `/nmm/reports` | `{ kind, period, week }` → opens (creates if needed) that report. 409 `not_open` if the week has not arrived or the month is over. Returns the report and the month's goals. |
| `GET` | `/nmm/reports/:id` | Full report + goals. Owner or super admin. |
| `PUT` | `/nmm/reports/:id` | Save sections. Allowed while `window.canEdit`, even after submission. |
| `POST` | `/nmm/reports/:id/submit` | Requires goals for the month and at least one highlight. |
| `DELETE` | `/nmm/reports/:id` | Drafts only, while the window is open. |
| `GET` | `/nmm/periods` | Months with reports, plus `current` and `currentWeek`. |

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
| `month` | Editable until the month ends. |
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

```
GET /nmm/ping   →  { "status": true, "message": "nmm reporting api alive", "units": 12, "period": "2026-09", "week": 1 }
```

Set `NMM_SITE_URL` to the web app's public URL so `/nmm/staff/invites` returns
complete `https://…/join/<token>` links.
