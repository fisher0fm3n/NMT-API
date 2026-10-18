# LoveWorld Expo API

The account, booking and forms service behind the LoveWorld Expo website
(loveworldexpo.com): KingsChat sign-in, exhibitors, SmartMeet one-on-one bookings,
registrations, sponsor enquiries and program applications.
Code: `routes/loveworld_expo.js`. Database: `loveworld_expo` on the same Postgres server as
KingsPresenter / NMM reporting, made with its tables on first use (or now:
`node scripts/expo-migrate.js`, which also loads `scripts/expo-seed.json` when there are no
exhibitors yet; `--seed` loads it again). Tests: `node --test test/loveworld_expo.test.js`
(needs a local Postgres).

## Settings (.env)

| Variable | |
| --- | --- |
| `LOVEWORLD_EXPO_DATABASE_URL` | `postgres://user:password@host:5432/loveworld_expo`. Unset: the KingsPresenter / NMM server (`KINGSPRESENTER_DATABASE_URL`, `KP_DATABASE_URL`, `NMM_DATABASE_URL`) with the database `loveworld_expo`, else `EXPO_DB_HOST/USER/PASSWORD/PORT/NAME` (then `KP_DB_*`, `NMM_DB_*`, `PCO_FN_DB_*`) |
| `EXPO_KC_CLIENT_ID` | The website's KingsChat client (default `630166b6-6431-4239-8036-c40b1b0f2652`); `EXPO_KC_CLIENT_SECRET` when its registration came with one |
| `EXPO_KC_API_KEY` | The api-key of that KingsChat project, sent when reading profiles (optional: without it the profile is read with the person's token alone) |
| `EXPO_SITE_URL` | The website, e.g. `https://www.loveworldexpo.com` (for `/expo/config`'s redirectUri) |
| `EXPO_API_KEY` | When set, every `/expo/*` call but `/expo/ping` must send `x-api-key` |
| `EXPO_ADMIN_KEY` | The `x-admin-key` for `/expo/admin/*` (unset: no admin routes) |
| `EXPO_TOKEN_SECRET` | Access-token signing key (unset: one is made once and kept in `settings`) |
| `EXPO_ACCESS_TTL_SECONDS` (3600), `EXPO_REFRESH_DAYS` (90) | Token lifetimes |
| `EXPO_START_DATE` (2026-11-09), `EXPO_END_DATE` (2026-11-15), `EXPO_UTC_OFFSET` (+01:00) | The event's days and clock |
| `EXPO_MEETING_MINUTES` (20), `EXPO_DAY_START_HOUR` (10), `EXPO_DAY_END_HOUR` (17), `EXPO_LUNCH_HOUR` (13), `EXPO_MAX_BOOKINGS_PER_DAY` (6) | SmartMeet slots |

## Authentication

| Header | Purpose |
| --- | --- |
| `x-api-key` | The app key, when `EXPO_API_KEY` is set (not for `/expo/ping`) |
| `Authorization: Bearer <accessToken>` | The signed-in person |
| `x-admin-key` | `/expo/admin/*` |

```
POST /expo/auth/kingschat   { "accessToken": "<KingsChat token>" | "code": "<authCode>", "deviceId"? }
```

The website sends people to `https://accounts.kingschat.online/log-in?clientId=<EXPO_KC_CLIENT_ID>`;
KingsChat posts its code back to the site's `/auth/kingschat/callback`, which exchanges it for
KingsChat tokens itself (as EspeesMax's site does) and posts the `accessToken` here. A `code`
is accepted instead, for apps that let this service do the exchange.

```json
{ "status": true, "accessToken": "<JWT, 1 h>", "refreshToken": "<opaque, 90 days>", "expiresIn": 3600, "deviceId": "<id>",
  "user": { "id", "kcId", "username", "name", "avatar", "email", "phone", "organisation", "role", "country", "zone", "createdAt", "lastLoginAt" } }
```

`POST /expo/auth/refresh { refreshToken }` returns a new pair (each refresh token works once);
`POST /expo/auth/logout { refreshToken }` ends that sign-in.

## Responses

Success: `{ "status": true, … }`. Failure: `{ "status": false, "error": "<code>", "message": "<for people>" }`.

| Error | HTTP | When |
| --- | --- | --- |
| `unauthorized_api_key` / `unauthorized_admin_key` / `admin_off` | 401 / 401 / 503 | Keys |
| `no_token` / `invalid_token` / `account_deleted` / `account_disabled` | 401 / 401 / 401 / 403 | Sign-in |
| `missing_code`, `kc_exchange_failed`, `kc_profile_failed`, `kc_no_identity`, `kc_not_configured` | 400, 502, 502, 502, 500 | KingsChat |
| `not_available` / `bad_date` / `bad_slot` | 404 / 400 / 400 | SmartMeet: exhibitor not taking bookings; not an Expo day; not one of its slots |
| `slot_taken` / `double_booked` / `day_full` | 409 | Someone got there first; you have a meeting then; `EXPO_MAX_BOOKINGS_PER_DAY` reached |
| `missing_fields` / `invalid_email` / `missing_topic` / `bad_program` / `bad_status` | 400 | Forms |
| `not_found` | 404 | |

## Endpoints

| Call | |
| --- | --- |
| `GET /expo/ping` | Alive; the number of accounts and exhibitors (no app key) |
| `GET /expo/config` | `{ kingschat: { clientId, loginUrl, redirectUri }, event: { start, end, days, utcOffset, meetingMinutes, dayStart, dayEnd, lunchHour, maxBookingsPerDay } }` |
| `POST /expo/auth/kingschat`, `/expo/auth/refresh`, `/expo/auth/logout` | Above |
| `GET /expo/me` | `{ user, counts: { bookings, registrations, applications } }` |
| `PATCH /expo/me { email?, phone?, organisation?, role?, country?, zone? }` | `{ user }` |
| `DELETE /expo/account` | The account and its bookings, for good |
| `GET /expo/exhibitors?q=&category=&zone=&smartmeet=1` | `{ exhibitors: [{ id, name, category, zone, stand, tagline, description, smartMeet, featured, meetingTopics, logo, website }] }` (active ones, by `sort` then name) |
| `GET /expo/exhibitors/:id` | `{ exhibitor }` |
| `GET /expo/smartmeet/days` | `{ days: ["2026-11-09", …], meetingMinutes }` |
| `GET /expo/smartmeet/availability?exhibitor=&date=YYYY-MM-DD` | `{ exhibitor, date, slots: [{ start: "2026-11-10T10:00:00", end, available }] }`: wall-clock times on the event's clock; booked and blocked slots are `available: false` |
| `GET /expo/smartmeet/bookings` | The signed-in person's bookings, soonest first (cancelled ones too, with `status`) |
| `POST /expo/smartmeet/bookings { exhibitorId, start: "2026-11-10T10:00", topic, notes?, name?, email?, organisation? }` | 201 `{ booking: { id, reference "SM-…", exhibitor: { id, name, stand }, start, end, startsAt, endsAt, name, email, organisation, topic, notes, location "SmartMeet Lounge · Table n", status, createdAt } }`; name/email/organisation default to the account's |
| `GET /expo/smartmeet/bookings/:id` | One booking of theirs |
| `DELETE /expo/smartmeet/bookings/:id` | Cancels it (`status: "cancelled"`); the slot is free again |
| `POST /expo/registrations { firstName, lastName, email, phone?, organisation?, role?, country?, zone?, interests?: [], pass? }` | 201 `{ reference "REG-…", id, createdAt }`; signed in or not (signed in: the profile fields are kept on the account) |
| `POST /expo/sponsor/enquiries { name, email, organisation, role?, interest?, programs?, message? }` | 201 `{ reference "SP-…", id, createdAt }` |
| `POST /expo/programs/applications { program: eagles-nest\|qubators\|content-creative, name, email, organisation?, summary?, data?: {} }` | 201 `{ reference "EN-…" / "QB-…" / "CC-…", id, createdAt }` |
| `GET /expo/programs/applications` | The signed-in person's applications |

### Admin (`x-admin-key`)

| Call | |
| --- | --- |
| `GET /expo/admin/stats` | Counts of users, exhibitors, bookings, registrations, enquiries, applications |
| `GET /expo/admin/users?q=&limit=` | Accounts; `POST /expo/admin/users/:id { disabled, reason? }` disables (signs out) or restores one |
| `GET /expo/admin/exhibitors` | Every exhibitor, with `availability`, `sort`, `active` |
| `POST /expo/admin/exhibitors { id?, name, category, zone, stand, tagline, description, smartMeet, featured, meetingTopics, availability, logo, website, sort, active }` | Makes one (`id` from the name when not given; an existing id is updated) |
| `POST /expo/admin/exhibitors/import { exhibitors: [...] }` | Several at once, each made or updated by `id` (the shape of `scripts/expo-seed.json`) |
| `PUT /expo/admin/exhibitors/:id { …fields }` | Changes the fields given |
| `DELETE /expo/admin/exhibitors/:id` | Removes it (and its bookings) |
| `GET /expo/admin/bookings?exhibitor=&date=&limit=` | Every booking |
| `GET /expo/admin/registrations`, `/expo/admin/enquiries`, `/expo/admin/applications?program=` | The forms, newest first |
| `POST /expo/admin/enquiries/:id { status: new\|contacted\|closed }`, `POST /expo/admin/applications/:id { status: submitted\|shortlisted\|accepted\|declined }` | Moves one along |

`availability` on an exhibitor (all optional): `{ "dayStart": 10, "dayEnd": 17, "slotMinutes": 20, "closedDates": ["2026-11-09"], "blocked": ["2026-11-10T11:00:00"] }`.

## The website

The Next.js site (loveworld-expo) talks to this service only from its own server (route
handlers under `/api/*` and `/auth/kingschat/*`), with `EXPO_API_URL` (this service up to
`/expo`, e.g. `https://nmt.loveworldapis.com/api/expo`) and `EXPO_API_KEY`. The person's
tokens live in HttpOnly cookies on the site; nothing here is called from the browser directly.
