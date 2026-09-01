# NMM Reporting API

App-facing API for **New Media Ministries** monthly reporting, served by this
Express app from `routes/nmm.js`. It reads and writes the same `nmm_reporting`
Postgres database as the web dashboard (`staff-reporting-web`), so a report
submitted in the app appears in the dashboard immediately, and vice versa.

All paths are prefixed with `/nmm`.

## Authentication

Two credentials are involved.

| Header | Purpose |
| --- | --- |
| `x-api-key` | The app key. Required on **every** `/nmm/*` call. |
| `Authorization: Bearer <token>` | The signed-in user. Required on everything except `/nmm/ping`, `/nmm/departments` and the sign-in call. |

The user token is returned by the sign-in call and is stored hashed in the
shared `sessions` table, so app tokens and web cookies are the same sessions
underneath. Tokens last 30 days by default (`NMM_SESSION_DAYS`).

`x-user-token: <token>` is accepted as an alternative to the `Authorization`
header if that is easier for the client.

### Sign in

```
POST /nmm/auth/kingschat
{ "code": "<authCode from KingsChat>" }
```

The app opens `https://accounts.kingschat.online/log-in?clientId=630166b6-6431-4239-8036-c40b1b0f2652&redirect_uri=<your redirect>`,
receives an `authCode`, and posts it here. If the app already holds a KingsChat
access token it can send `{ "accessToken": "..." }` instead.

```json
{
  "status": true,
  "token": "…",
  "expiresAt": "2026-10-01T21:00:00.000Z",
  "next": "home",
  "user": { "id": 2, "kcUsername": "testuser", "fullName": "…", "role": "director", "status": "approved", … }
}
```

`next` tells the app which screen to show:

| `next` | Meaning |
| --- | --- |
| `onboarding` | New account. Collect full name + department, POST `/nmm/onboarding`. |
| `pending` | Waiting for an administrator to approve. Poll `/nmm/me`. |
| `rejected` | The request was declined. |
| `home` | Approved. Full access. |

`POST /nmm/auth/logout` revokes the token.

## Response shape

Success is always `{ "status": true, … }`. Failure is
`{ "status": false, "error": "<code>", "message": "<human readable>" }` with a
matching HTTP status. Error codes you should handle:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `unauthorized_api_key` | 401 | Bad or missing `x-api-key`. |
| `no_token` / `invalid_token` | 401 | Not signed in, or the session expired. Re-run sign-in. |
| `onboarding_required` | 403 | Send the user to onboarding. |
| `approval_required` | 403 | Account not approved yet. |
| `forbidden` | 403 | Not the owner, or not a super admin. |
| `report_locked` | 409 | The report is submitted; it cannot be edited or deleted. |
| `validation_failed` | 422 | Submission rejected; `message` says why. |
| `upload_error` | 400/413 | File too large or the type is not allowed. |

## Account

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/nmm/me` | Current user + `next`. |
| `PATCH` | `/nmm/me` | `{ fullName, phone }`. The only fields a user may change about themselves. |
| `GET` | `/nmm/departments` | Active departments, for the onboarding picker. No token needed. |
| `POST` | `/nmm/onboarding` | `{ fullName, departmentId }` → account becomes `pending`. |

Department and role are administrator-only; they are not editable through
`PATCH /nmm/me`.

## Reports

One report per user per calendar month. A period is always `YYYY-MM`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/nmm/reports` | The caller's reports, newest first, each with `goals_done`/`goals_total`. |
| `POST` | `/nmm/reports` | `{ period }` → creates the month's draft, or returns the existing one. |
| `GET` | `/nmm/reports/period/:period` | The caller's report for a month. Add `?create=1` to open a draft if there is none, otherwise 404. |
| `GET` | `/nmm/reports/:id` | Full report. Owner, or any super admin. |
| `PUT` | `/nmm/reports/:id` | Save the four sections. Draft only. |
| `POST` | `/nmm/reports/:id/submit` | Locks the report and stamps today's date. |
| `DELETE` | `/nmm/reports/:id` | Draft only. Removes the sections and attachment files too. |
| `GET` | `/nmm/periods` | Months that already have reports, plus the current month. |

### The report object

```json
{
  "id": 7, "period": "2027-01", "status": "draft",
  "directorate": "Social Media",
  "head_of_department": "Test Member",
  "submission_date": null,
  "submitted_at": null,
  "department_name": "Social Media",
  "author_name": "Test Member", "author_username": "testuser",
  "goals":      [{ "id": 4, "goal": "…", "intended_outcome": "…", "target_date": "20 Jan", "completed": false, "completed_at": null }],
  "platforms":  [{ "id": 3, "platform": "…", "purpose": "…", "hosted_on": "IMM", "status": "Live" }],
  "highlights": [{ "id": 2, "goal": "…", "purpose": "…", "status_impact": "…" }],
  "relations":  [{ "id": 1, "activity": "…", "overlap": "…", "collaboration": "…", "suggestions": "…" }],
  "attachments":[{ "id": 4, "original_name": "photo.png", "mime_type": "image/png", "size_bytes": 1207, "created_at": "…" }]
}
```

**Three fields are derived by the server and cannot be set by the client.**
Anything you send for them is ignored:

- `directorate` — the user's department.
- `head_of_department` — the user's full name (change it via `PATCH /nmm/me`).
- `submission_date` — stamped with the current date at submit time.

### Saving

`PUT /nmm/reports/:id` replaces all four sections with what you send. Send the
whole set each time, not a delta.

```json
{
  "goals": [{ "id": 4, "goal": "Launch the mobile app", "intended_outcome": "…", "target_date": "20 Jan" },
            { "id": null, "goal": "Grow the channel", "intended_outcome": "…", "target_date": "To confirm" }],
  "platforms":  [{ "id": null, "platform": "…", "purpose": "…", "hosted_on": "IMM", "status": "Live" }],
  "highlights": [{ "id": null, "goal": "…", "purpose": "…", "status_impact": "…" }],
  "relations":  [{ "id": null, "activity": "…", "overlap": "…", "collaboration": "…", "suggestions": "…" }]
}
```

Keep the `id` on goals you are editing — that is how a goal's completed state
survives an edit. A goal sent with `id: null` is created; a stored goal you omit
is deleted. Rows where every field is blank are dropped. `hosted_on` is free
text (IMN / IMM / website) and platform `status` is one of Live, In progress,
Planned.

Submission requires at least one non-empty goal, a department on the account and
a full name on the account; otherwise you get `validation_failed` (422).

### Goals

```
PATCH /nmm/goals/:id      { "completed": true }
```

This is the goal tracker, and it deliberately keeps working **after** the report
is submitted. Progress for a report is `goals_done / goals_total` in the list
endpoints.

### Attachments

```
POST /nmm/reports/:id/attachments      multipart/form-data, field: files
```

Repeat the `files` field for several files, up to 10 per request, 25 MB each
(`NMM_MAX_UPLOAD_MB`). Images, PDF, Word, Excel, PowerPoint, text, CSV and zip
are accepted. Adding and removing attachments is limited to the report's owner
while it is still a draft; both return `report_locked` (409) once it has been
submitted.

```
GET    /nmm/attachments/:id            streams the file (?download=1 forces a save)
DELETE /nmm/attachments/:id
```

Images and PDFs stream inline; everything else is sent as an attachment.

## Admin (super admin only)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/nmm/admin/users` | All accounts. `?status=new\|pending\|approved\|rejected`. Pending first. |
| `PATCH` | `/nmm/admin/users/:id` | `{ status, role, departmentId }`, any subset. |
| `GET` | `/nmm/admin/departments` | Including inactive ones. |
| `POST` | `/nmm/admin/departments` | `{ name }`. |
| `PATCH` | `/nmm/admin/departments/:id` | `{ name, isActive }`. |
| `GET` | `/nmm/admin/reports` | Every submission. `?period=&department=&status=`. |
| `GET` | `/nmm/admin/overview` | `?period=YYYY-MM` → per-department counts, totals and pending approvals. |
| `POST` | `/nmm/admin/reports/:id/reopen` | Unlocks a submitted report for editing. |

`status` is one of `new`, `pending`, `approved`, `rejected`. `role` is
`director` or `super_admin`. An admin cannot suspend or demote their own
account.

## Configuration

Set these in the API's `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NMM_DATABASE_URL` | – | Connection string for `nmm_reporting`. If set, the `NMM_DB_*` fields below are ignored. |
| `NMM_DB_HOST` / `NMM_DB_NAME` / `NMM_DB_USER` / `NMM_DB_PASSWORD` / `NMM_DB_PORT` | `102.219.189.166` / `nmm_reporting` / `postgres` / `PCO_FN_DB_PASSWORD` / `5432` | Used when there is no connection string. |
| `NMM_API_KEY` | falls back to `GENERAL_API_KEY` | The `x-api-key` value the app must send. |
| `NMM_KC_CLIENT_ID` | `630166b6-6431-4239-8036-c40b1b0f2652` | KingsChat OAuth client id. |
| `NMM_KC_API_KEY` | – | Optional key sent with KingsChat profile requests. |
| `NMM_UPLOAD_DIR` | `<cwd>/uploads/nmm` | **Must be the same folder as the web app's `UPLOAD_DIR`** if both should serve the same attachments. |
| `NMM_MAX_UPLOAD_MB` | `25` | Per-file limit. |
| `NMM_SESSION_DAYS` | `30` | Token lifetime. |
| `NMM_SUPER_ADMIN_KC_USERNAMES` | – | Comma-separated usernames auto-approved as super admins on first sign-in. |

The schema itself is owned by the web app: run `npm run db:migrate` there. This
API never creates or alters tables.

## Health check

```
GET /nmm/ping        →  { "status": true, "message": "nmm reporting api alive", "departments": 6 }
```

Needs the app key only. It confirms the database connection as well as the
process, since it counts the active departments.
