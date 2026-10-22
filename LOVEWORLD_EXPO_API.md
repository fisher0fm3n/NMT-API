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
| `EXPO_KC_API_KEY` (or `KINGSCHAT_API_KEY`, the website's name for it) | The api-key of that KingsChat project, sent when reading profiles. Without it KingsChat may refuse the profile (`kc_profile_failed`, "Could not read your KingsChat profile"); the server log then has the status KingsChat answered with |
| `EXPO_SITE_URL` | The website, e.g. `https://www.loveworldexpo.com` (for `/expo/config`'s redirectUri, and the links in KingsChat messages) |
| `EXPO_KC_MESSAGES` (on) | `off` stops the KingsChat messages about bookings (below). They also need `EXPO_KC_API_KEY` |
| `EXPO_KC_MESSAGES_URL` | KingsChat's messages API (default `https://connect.kingsch.at/developer/api/messages`); tests point it at a stand-in |
| `EXPO_KC_DEBUG` | `1` also logs each message's request body; every send's KingsChat answer is always logged (`[expo] KingsChat message …`) |
| `EXPO_API_KEY` | When set, every `/expo/*` call but `/expo/ping` must send `x-api-key` |
| `EXPO_ADMIN_KEY` | The `x-admin-key` for `/expo/admin/*` (unset: no admin routes) |
| `EXPO_TOKEN_SECRET` | Access-token signing key (unset: one is made once and kept in `settings`) |
| `EXPO_ACCESS_TTL_SECONDS` (3600), `EXPO_REFRESH_DAYS` (90) | Token lifetimes |
| `EXPO_START_DATE` (2026-11-09), `EXPO_END_DATE` (2026-11-15), `EXPO_UTC_OFFSET` (+01:00) | The event's days and clock |
| `EXPO_MEETING_MINUTES` (20), `EXPO_DAY_START_HOUR` (10), `EXPO_DAY_END_HOUR` (17), `EXPO_LUNCH_HOUR` (13), `EXPO_MAX_BOOKINGS_PER_DAY` (6) | SmartMeet slots |
| `EXPO_RESCHEDULE_CUTOFF_MINUTES` (15) | A visitor can move a meeting to another time until this many minutes before it starts |

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
  "user": { "id", "kcId", "username", "name", "avatar", "email", "phone", "organisation", "role", "country", "zone", "exhibitorId", "admin", "createdAt", "lastLoginAt" } }
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
| `too_late` / `same_time` | 409 / 400 | Moving a meeting less than `EXPO_RESCHEDULE_CUTOFF_MINUTES` before it starts; moving it to the time it already has |
| `missing_fields` / `invalid_email` / `missing_topic` / `bad_program` / `bad_status` | 400 | Forms |
| `not_exhibitor` | 403 | `/expo/exhibitor/*`: the account is not on an exhibitor's team |
| `last_admin` | 409 | Taking admin away from the only admin account |
| `not_found` | 404 | |

## Endpoints

| Call | |
| --- | --- |
| `GET /expo/ping` | Alive; the number of accounts and exhibitors (no app key) |
| `GET /expo/config` | `{ kingschat: { clientId, loginUrl, redirectUri }, event: { start, end, days, utcOffset, meetingMinutes, dayStart, dayEnd, lunchHour, maxBookingsPerDay } }` |
| `POST /expo/auth/kingschat`, `/expo/auth/refresh`, `/expo/auth/logout` | Above |
| `GET /expo/me` | `{ user, counts: { bookings, registrations, applications }, exhibitor: { id, name, stand, smartMeet } \| null }` (`exhibitor`: the one the account runs, when the admin has put it on a team). `user.profileComplete` is false until `title`, `firstName`, `lastName`, `email`, `phone`, `country`, `zone` and `church` are all filled in (first and last name start from KingsChat's); the website asks for them before anything else |
| `PATCH /expo/me { title?, firstName?, lastName?, email?, phone?, country?, zone?, church?, organisation?, role? }` | `{ user }`: only the fields sent change |
| `DELETE /expo/account` | The account and its bookings, for good |
| `GET /expo/exhibitors?q=&category=&zone=&smartmeet=1` | `{ exhibitors: [{ id, name, category, zone, stand, tagline, description, smartMeet, featured, meetingTopics, logo, website }] }` (active ones, by `sort` then name) |
| `GET /expo/exhibitors/:id` | `{ exhibitor }` |
| `GET /expo/smartmeet/days` | `{ days: ["2026-11-09", …], meetingMinutes }` |
| `GET /expo/smartmeet/availability?exhibitor=&date=YYYY-MM-DD` | `{ exhibitor, date, slots: [{ start: "2026-11-10T10:00:00", end, available }] }`: wall-clock times on the event's clock; booked and blocked slots are `available: false` |
| `GET /expo/smartmeet/bookings` | The signed-in person's bookings, soonest first (cancelled ones too, with `status`) |
| `POST /expo/smartmeet/bookings { exhibitorId, start: "2026-11-10T10:00", topic, notes?, name?, email?, organisation? }` | 201 `{ booking: { id, reference "SM-…", exhibitor: { id, name, stand }, start, end, startsAt, endsAt, name, email, organisation, topic, notes, location "SmartMeet Lounge · Table n", status, createdAt } }`; name/email/organisation default to the account's |
| `GET /expo/smartmeet/bookings/:id` | One booking of theirs |
| `PATCH /expo/smartmeet/bookings/:id { start: "2026-11-11T14:20" }` | Moves the visitor's own confirmed meeting to another free slot of the same exhibitor, until `EXPO_RESCHEDULE_CUTOFF_MINUTES` (15) before it starts; the reference and table stay, the old slot is freed, and both sides get a KingsChat message with the old and new times. Bookings carry `rescheduledAt`, `rescheduleCount` and `rescheduleUntil` (the last moment it can be moved) |
| `DELETE /expo/smartmeet/bookings/:id { reason? }` | Cancels it (`status: "cancelled"`, `cancelledBy: "visitor"`, `cancelReason`); the slot is free again, and both sides get a KingsChat message |
| `POST /expo/registrations { firstName, lastName, email, phone?, organisation?, role?, country?, zone?, interests?: [], pass?, passDay?, passPrice?, passCurrency? }` | 201 `{ reference "REG-…", id, createdAt, registration }`; signed in or not (signed in: the profile fields are kept on the account). `passDay` is the day of a one-day pass (an Expo day, else `bad_date`); `passPrice` / `passCurrency` are the price the website quoted from its own list. A free pass is `status: "confirmed"` at once, one with a price `"pending"` until the Expo team confirms it |
| `GET /expo/registrations` | The signed-in person's registrations, newest first: `{ registrations: [{ id, reference, firstName, lastName, email, …, pass, passDay, passPrice, passCurrency, status, createdAt }] }` |
| `POST /expo/sponsor/enquiries { name, email, organisation, role?, interest?, programs?, message? }` | 201 `{ reference "SP-…", id, createdAt }` |
| `POST /expo/programs/applications { program: eagles-nest\|qubators\|content-creative, name, email, organisation?, summary?, data?: {} }` | 201 `{ reference "EN-…" / "QB-…" / "CC-…", id, createdAt }` |
| `GET /expo/programs/applications` | The signed-in person's applications |

### An exhibitor's team (signed in; the account is on the team, see admin below)

| Call | |
| --- | --- |
| `GET /expo/exhibitor` | `{ exhibitor (with availability, sort, active), counts: { bookings, cancelled }, days: [{ date, bookings, slots }], team: [{ id, username, name, avatar, email }] }`: the overview; `slots` is how many a day still has before bookings |
| `PATCH /expo/exhibitor { tagline?, description?, meetingTopics?, logo?, website?, smartMeet?, availability? }` | `{ exhibitor }`: how the stand reads and its SmartMeet settings. The name, stand, zone, category, featured, active and sort are the admin's and are ignored here |
| `GET /expo/exhibitor/bookings?date=` | Every meeting booked with the exhibitor, soonest first, each with the booker's `username` and `avatar` besides the booking's name, email and organisation; `date` keeps one day |
| `DELETE /expo/exhibitor/bookings/:id { reason? }` | Someone on the team cancels a meeting with the exhibitor (`cancelledBy: "exhibitor"`); the slot is free again, and both sides get a KingsChat message. 404 when it is not this exhibitor's or is already cancelled |

### Admin (`x-admin-key`)

| Call | |
| --- | --- |
| `GET /expo/admin/stats` | Counts of users, exhibitors, bookings, registrations, enquiries, applications |
| `GET /expo/admin/users?q=&exhibitor=&limit=` | Accounts, each with `exhibitor: { id, name } \| null` and `admin`; `exhibitor=` is one exhibitor's team |
| `POST /expo/admin/users/:id { disabled?, reason?, admin? }` | `disabled` disables (signs out) or restores the account; `admin` grants or takes away the website's admin area (the last admin cannot be taken away: `last_admin`). `{ user, disabled, admin }` |
| `POST /expo/admin/users/:id/exhibitor { exhibitorId }` | Puts the account on that exhibitor's team (it then runs the exhibitor at `/expo/exhibitor`); `exhibitorId: null` takes it off. `{ user }` |
| `DELETE /expo/admin/users/:id` | Deletes the account and everything it made, all or nothing: its SmartMeet meetings (the slots free up; exhibitors are not messaged), passes, programme applications, sponsor enquiries, its message-log entries and its sign-ins. The last admin cannot be deleted (`last_admin`). Its tokens then get `401 account_deleted`. `{ deleted, removed: { bookings, registrations, applications, enquiries, messages } }` |
| `GET /expo/admin/exhibitors` | Every exhibitor, with `availability`, `sort`, `active` and `team` (how many accounts run it) |
| `POST /expo/admin/exhibitors { id?, name, category, zone, stand, tagline, description, smartMeet, featured, meetingTopics, availability, logo, website, sort, active }` | Makes one (`id` from the name when not given; an existing id is updated) |
| `POST /expo/admin/exhibitors/import { exhibitors: [...] }` | Several at once, each made or updated by `id` (the shape of `scripts/expo-seed.json`) |
| `PUT /expo/admin/exhibitors/:id { …fields }` | Changes the fields given |
| `DELETE /expo/admin/exhibitors/:id` | Removes it (and its bookings) |
| `GET /expo/admin/bookings?exhibitor=&date=&limit=` | Every booking |
| `GET /expo/admin/notifications?booking=&limit=` | The KingsChat messages sent (booking messages and welcomes), newest first: `{ id, bookingId, reference, kind, user, recipientKcId, status: sent\|failed\|skipped, error, kcMessageId, body, createdAt, sentAt }` |
| `GET /expo/admin/registrations?pass=&status=`, `/expo/admin/enquiries`, `/expo/admin/applications?program=&status=` | The forms, newest first |
| `POST /expo/admin/registrations/:id { status: pending\|confirmed\|cancelled }`, `POST /expo/admin/enquiries/:id { status: new\|contacted\|closed }`, `POST /expo/admin/applications/:id { status: submitted\|shortlisted\|accepted\|declined }` | Moves one along |

`availability` on an exhibitor (all optional): `{ "dayStart": 10, "dayEnd": 17, "slotMinutes": 20, "closedDates": ["2026-11-09"], "blocked": ["2026-11-10T11:00:00"] }`.

## KingsChat messages

**Welcome.** When someone signs in for the first time (the sign-in makes their account, and
`POST /expo/auth/kingschat` answers `created: true`), they get a KingsChat welcome: what LoveWorld
Expo is, its dates, the seven sector days, launches and demos, practical sessions, and SmartMeet,
with links to book a meeting and see the programme. It is sent once per account (recorded in
`notifications` with `kind: "welcome"`); accounts made before this was added are not welcomed.

### About bookings

When a SmartMeet meeting is booked, moved by the visitor (`rescheduled`), and when it is cancelled by the visitor or by the exhibitor's
team, the visitor and everyone on the exhibitor's team (accounts with `exhibitor_id` set) get a
KingsChat message with the details: who, when (on the event's clock), where, the topic, the
reference, the reason when one was given, and a link back to the website.

They follow KingsChat's *Send a Message* API: `POST https://connect.kingsch.at/developer/api/messages`
with the project's `api-key` (`EXPO_KC_API_KEY`) and no `sender_id`, so they come from the
KingsChat account the project was created with. That needs the **messages_on_behalf_of_project**
scope enabled for that project in the KingsChat developer console; without it every send fails
with `project_cannot_send_messages`. A message to the project's own account cannot be delivered
(`cannot_send_to_self`) and is recorded as `skipped`, so test with a second KingsChat account as
the visitor. People who signed in to the website have authorized the
project, so they can be reached; a send to anyone else fails with `recipient_not_authorized`.

Messages go to the person's KingsChat `profile.id` (`users.kc_user_id`, saved at sign-in; accounts
that have not signed in since this was added fall back to `kc_id`). Each text is kept under the
1024 bytes KingsChat shows inline (long notes are shortened). Sending happens after the answer
to the booking or cancellation, so KingsChat being slow or refusing never fails either; every send
is recorded in `notifications` with its status and KingsChat's error, at
`GET /expo/admin/notifications`.

## Who runs the admin area

The website's `/admin` is for KingsChat accounts with `admin: true` (`users.is_admin`). An
admin grants it to another account from the website's Users page; the first one is set in the
database, once that person has signed in to the website at least once:

```sql
UPDATE users SET is_admin = true WHERE lower(kc_username) = 'their_username';
```

The website still calls `/expo/admin/*` with its own `EXPO_ADMIN_KEY`; the flag decides who may
make it do so.

## The website

The Next.js site (loveworld-expo) talks to this service only from its own server (route
handlers under `/api/*` and `/auth/kingschat/*`), with `EXPO_API_URL` (this service up to
`/expo`, e.g. `https://nmt.loveworldapis.com/api/expo`) and `EXPO_API_KEY`. The person's
tokens live in HttpOnly cookies on the site; nothing here is called from the browser directly.
