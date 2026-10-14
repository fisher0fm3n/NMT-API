# KingsPresenter API

The account service for **KingsPresenter** (the church presentation app) and
**KingsPresenter Remote** (phones that run the church screens through a relay):
KingsChat sign-in, devices, library sync, media, relays and Remote sessions.
Code: `routes/kingspresenter.js`. Database: `kingspresenter` on the same Postgres
server as NMM reporting, made with its tables on first use (or now:
`node scripts/kp-migrate.js`).

## Authentication

| Header | Purpose |
| --- | --- |
| `x-api-key` | The app key, when `KP_API_KEY` is set. Every `/kp/*` call except `/kp/ping`, the KingsChat callback and relay reports. |
| `Authorization: Bearer <accessToken>` | The signed-in account. |

```
POST /kp/auth/kingschat   { "code": "<authCode>", "deviceId"?, "deviceName"?, "deviceKind"?: "desktop"|"phone"|"web" }
```

The app opens
`https://accounts.kingschat.online/log-in?clientId=<KP_KC_CLIENT_ID>&redirect_uri=<KP_SITE_URL>/auth/kingschat/callback`,
takes the `code` KingsChat sends back, and posts it here. An existing KingsChat
`accessToken` may be sent instead. KingsPresenter's registration with KingsChat is a
Web application whose Redirect URL is this API's own callback
(`https://nmt.loveworldapis.com/api/kp/auth/kingschat/callback`, so `KP_SITE_URL` is
`https://nmt.loveworldapis.com/api/kp`) and whose Callback Delivery is Form POST.

```json
{ "status": true, "accessToken": "<JWT, 1 h>", "refreshToken": "<opaque, 90 days>",
  "expiresIn": 3600, "deviceId": "<uuid>",
  "user": { "id", "kcId", "username", "name", "avatar", "email", "phone", "createdAt" } }
```

The access token is an HS256 JWT (`sub` = user id, `dev` = device id). Relays check
it by calling `GET /kp/me`. `POST /kp/auth/refresh { refreshToken }` returns a new
pair; each refresh token works once. `POST /kp/auth/logout { refreshToken }` ends
that device's sign-in.

### The callback

`/kp/auth/kingschat/callback` (GET or POST, no app key) is where KingsChat sends
people back. It takes the code from the posted form or JSON (`code`, `authCode`,
`authorizationCode`, `authorization_code`) or from the address, signs the person in,
and returns a page (`Cache-Control: no-store`) that hands the result on:

- In KingsPresenter Remote's sign-in view: the tokens, by
  `window.ReactNativeWebView.postMessage` — `{ type: "kp-auth", status, accessToken,
  refreshToken, expiresIn, deviceId, user, ticket, deepLink }` (`?kind=phone`, `?device=`
  name the device; a phone by default).
- In a browser (the desktop app signing in through it): a one-time ticket, opened as
  `kingspresenter://auth?ticket=<ticket>` (an "Open KingsPresenter" button when the link
  does not open by itself). The app swaps it for its tokens:

```
POST /kp/auth/ticket   { "ticket", "deviceId"?, "deviceName"?, "deviceKind"?: "desktop" }
```

The answer is as `POST /kp/auth/kingschat`'s. A ticket works once and for 5 minutes
(`invalid_ticket`, 401, after that); collecting it retires the tokens the page was given,
so a browser sign-in leaves no phantom phone on the account. The page posts nothing to
the window that opened it.

The desktop app usually takes the code out of KingsChat's redirect before this page
loads (its own sign-in window) and posts it to `/kp/auth/kingschat` itself; the page is
for phones and for sign-ins through an ordinary browser.

## Responses

Success: `{ "status": true, … }`. Failure: `{ "status": false, "error": "<code>", "message": "<for people>" }`.

| Error | HTTP | When |
| --- | --- | --- |
| `unauthorized_api_key` | 401 | Missing or wrong `x-api-key` |
| `no_token` / `invalid_token` | 401 | No or expired access token, used-up refresh token |
| `missing_code` | 400 | No `code` or `accessToken` |
| `missing_ticket` / `invalid_ticket` | 400 / 401 | No ticket; one expired or already collected |
| `account_disabled` | 403 | The account was disabled by the administrator |
| `unauthorized_admin_key` / `admin_off` | 401 / 503 | Wrong `x-admin-key`; `KP_ADMIN_KEY` unset |
| `device_limit` | 403 | Signed in on as many devices as `KP_MAX_DEVICES` allows; sign one out first |
| `cloud_used` | 403 | No Cloud listening left this month (the answer carries `cloud`) |
| `cloud_off` / `cloud_unavailable` | 503 / 502 | No `KP_DEEPGRAM_API_KEY` on this server; Deepgram gave no token |
| `too_many` | 429 | More Cloud listening streams this hour than `KP_CLOUD_TOKENS_PER_HOUR` |
| `kc_exchange_failed` / `kc_profile_failed` / `kc_no_identity` | 502 | KingsChat refused (the server log says why; `user_not_authorized` on the profile: `KP_KC_API_KEY` is another project's than `KP_KC_CLIENT_ID`) |
| `kc_not_configured` | 500 | `KP_KC_CLIENT_ID` or `KP_KC_API_KEY` (or their `NMM_*`) unset |

## Endpoints

| Call | |
| --- | --- |
| `GET /kp/ping` | Alive; the number of accounts |
| `GET /kp/config` | `{ kingschat: { clientId, loginUrl, redirectUri }, relays: [{ name, url, region }] }` |
| `POST /kp/auth/kingschat`, `/kp/auth/refresh`, `/kp/auth/logout` | Above |
| `/kp/auth/kingschat/callback`, `POST /kp/auth/ticket` | KingsChat's redirect and the desktop's ticket (above) |
| `GET /kp/me` | `{ user }` |
| `GET /kp/devices` | The computers and phones signed in: `{ devices: [{ id, name, kind, lastSeen, signedIn, current }], signedIn, max }` |
| `DELETE /kp/devices/:id` | Signs that device out and forgets it |
| `DELETE /kp/account` | The account, its library and media, for good |
| `GET /kp/sync/pull?since=<cursor>` | Library changes after a cursor: `{ changes: [{ kind, id, rev, updatedAt, deletedAt, doc }], cursor, more }` (500 at a time) |
| `POST /kp/sync/push { docs: [{ kind, id, doc }] }` | `{ accepted, rejected: [{ kind, id, current }], cursor }`; the later `doc.updatedAt` wins |
| `HEAD/PUT/GET /kp/media/:sha256` | Media files by content hash (`PUT` body: the file; refused unless it matches the hash) |
| `GET /kp/relays` | The relays to use: `{ relays: [{ name, url, region }] }` |
| `POST /kp/relay/events` | For relays (`x-relay-key: KP_RELAY_KEY`): `{ relay: "wss://…", events: [{ t: opened\|closed\|join\|leave, sessionId, … }] }` |
| `GET /kp/remote/sessions` | The account's church computers' Remote sessions, newest first, with how many phones joined |
| `POST /kp/recordings/summary` | A recording's transcript → its summary by the AI (below) |
| `GET /kp/recordings/summary/:recordingId` | The summary kept for a recording |
| `GET /kp/updates/latest?platform=&arch=&version=` | The latest KingsPresenter for that computer, when newer than `version`; 204 when not (below) |
| `GET /kp/updates/files/:version/:platform/:arch` | The installer |
| `GET /kp/updates/releases` | Every release, newest first |
| `PUT /kp/updates/upload` | For the build (`x-upload-key: KP_UPDATE_UPLOAD_KEY`): an installer (below) |

Library kinds: `services`, `songs`, `presentations`, `media`, `templates`, `settings`.

## Recording summaries

KingsPresenter posts a recording's transcript when the recording stops (its docs:
`docs/recording-ai`); the AI (the API's OpenAI client, `KP_SUMMARY_MODEL`) writes the summary.

```
POST /kp/recordings/summary
{ "recordingId": "2026-10-14-7c31d2", "language": "en",
  "transcript": [{ "t": 0.0, "text": "Okay let's get started…" }, { "t": 12.1, "text": "Turn with me to Romans chapter 12 verse 11." }, …] }
```

`t` is seconds from the start; `language` is ISO 639-1 (English when absent); `recordingId` is
optional. The answer (`200`) is the summary: `title`, `summary { short, full }`, `keyPoints`
(with times and scriptures), `scriptures` (reference in English book names, USFM `bookId`,
chapter, verse, verseEnd, the mentions with the words as heard, a `note` when the reference had
to be worked out), `decisions`, `actionItems`, `openQuestions`, `speakers`, `themes`, `version: 1`,
`language` — the shape in `docs/recording-ai/response.schema.json` there, plus `status: true`.
It is kept by `recordingId`: the same transcript again answers from what is kept
(`cached: true`); a changed transcript is summarised afresh.

| Error | HTTP | When |
| --- | --- | --- |
| `bad_request` | 400 | No transcript, or a line without `t` |
| `too_long` | 413 | More than `KP_SUMMARY_MAX_CHARS` characters |
| `ai_failed` | 502 | The AI refused or sent no summary |
| `ai_busy` | 503 | The AI service is busy or down (KingsPresenter tries again later) |
| `summaries_off` | 503 | `OPENAI_API_KEY` is not set on this server |

## Updates

KingsPresenter asks, a little after it starts and every few hours (its docs: `docs/updates`):

```
GET /kp/updates/latest?platform=darwin&arch=arm64&version=0.1.1
```

`platform` is `darwin` or `win32`; `arch` is `arm64` or `x64`; `version` is the one asking.
`200` with the latest release for that computer when it is newer:

```json
{ "status": true, "version": "0.1.2", "notes": "- Follows the reading verse by verse…", "releasedAt": "2026-10-18T10:00:00Z",
  "url": "https://nmt.loveworldapis.com/api/kp/updates/files/0.1.2/darwin/arm64", "size": 183562240, "sha256": "9f2c…", "filename": "KingsPresenter-0.1.2-arm64.dmg" }
```

`204` when there is nothing newer. `url` is `GET /kp/updates/files/:version/:platform/:arch`
(signed in): the installer, with `Content-Length` and `X-Sha256`. `url` starts with
`KP_PUBLIC_URL` (the API's public address up to its mount point, e.g.
`https://nmt.loveworldapis.com/api`), else this request's own host.

The build (GitHub Actions in KingsPresenter, `scripts/update-upload.js`) sends each installer:

```
PUT /kp/updates/upload        the file as the body (streamed to KP_RELEASES_DIR)
x-upload-key: <KP_UPDATE_UPLOAD_KEY>
x-version: 0.1.2   x-platform: darwin|win32   x-arch: arm64|x64
x-filename: KingsPresenter-0.1.2-arm64.dmg   x-sha256: <the file's>   x-notes: <release notes, Base64>
```

`201 { release }`; a second upload for the same version and platform replaces the first.
Errors: `unauthorized_upload_key` (401), `bad_request` / `hash_mismatch` / `empty_upload`
(400), `too_large` (413, over `KP_MAX_RELEASE_MB`), `uploads_off` (503, no key set).

## May this copy run?

The desktop app asks at start and every few hours, signed in or not:

```
GET /kp/app/check?installId=<uuid>&version=0.1.1&platform=darwin&arch=arm64&name=<computer>   (x-api-key; a Bearer token when signed in)
→ { "status": true, "allowed": true|false, "reason": ""|"update"|"disabled", "message", "minVersion" }
```

`installId` is the copy's own id (made once on that computer); every copy that asks is kept
in `installs` with its version, computer name, platform, last account and when it was last
seen. `update`: the copy is older than the oldest version allowed and must update first.
`disabled`: the copy, or the account signed in on it, was disabled. The app keeps the last
answer, so a copy told to stop stays stopped offline (one that updates past the version
required is let in again by itself).

A disabled account also cannot sign in (`account_disabled`, 403) or use any signed-in call.

### Cloud listening: a monthly allowance

Speech recognised online ("Cloud" in the app) is limited per account and calendar month
(UTC): `KP_CLOUD_MINUTES` (120) unless the administrator set the account's own. The desktop
app asks before it listens online, reports the seconds of sound it sent as it goes, and
stops when nothing is left. Computers signed in to one account share its allowance.

| Call | |
| --- | --- |
| `GET /kp/listening` | `{ cloud: { month, limitSeconds, usedSeconds, remainingSeconds, custom, resetsAt } }` (`custom`: the account's own limit) |
| `POST /kp/listening/usage` | `{ "seconds": 30 }` used since the last report (whole seconds, at most 6 hours a report); answers `{ cloud }` as it now stands |
| `POST /kp/listening/token` | A token for one stream: `{ token, expiresIn, cloud }`. The app opens Deepgram's `/v1/listen` with `Authorization: Bearer <token>` within `expiresIn` seconds; the stream then runs until it is closed |

`/kp/me` carries `cloud` too.

The speech service's key (`KP_DEEPGRAM_API_KEY`) never leaves this server: the token is made
from it by Deepgram's `/v1/auth/grant` and lasts 30 seconds, so a copy of the app carries
nothing worth taking. A token is only given while the account has time left this month
(`cloud_used`, 403, with `cloud`), and an account may open at most `KP_CLOUD_TOKENS_PER_HOUR`
streams an hour (`too_many`, 429).

### The administrator (`x-admin-key: KP_ADMIN_KEY`)

| Call | |
| --- | --- |
| `GET /kp/admin/installs?q=` | Copies, newest first (q: computer name, version, account name or id) |
| `POST /kp/admin/installs/:id` | `{ "disabled": true, "reason": "Licence ended." }` — one copy off (`false`: on again) |
| `GET /kp/admin/users?q=` | Accounts, with their copies, signed-in devices and this month's `cloud` listening; `cloudMinutes`: the default |
| `POST /kp/admin/users/:id` | `{ "disabled": true, "reason" }` — `:id` is the account id or its KingsChat username |
| `POST /kp/admin/users/:id/cloud` | `{ "minutes": 600 }` — the account's own monthly cloud listening (`0` stops it; `null`: the default again). What is used this month stays |
| `DELETE /kp/admin/users/:id` | The account deleted for good, with its library, media, recording summaries, cloud listening, devices and sign-ins (its copies stay, not signed in). Says what went: `{ "deleted": true, "user", "removed": { "documents", "media", "summaries", "devices" } }`. Its copies are signed out at once. Signing in with KingsChat again makes a new, empty account; to keep someone out, disable the account instead |
| `GET /kp/admin/policy` | `{ minVersion, message, cloudMinutes }` (`cloudMinutes` is read only: `KP_CLOUD_MINUTES`) |
| `PUT /kp/admin/policy` | `{ "minVersion": "0.2.0", "message": "Please update before Sunday." }` — `""` lets every version run |

An installer uploaded with `x-required: 1` becomes the oldest version allowed by itself.

```bash
curl -H "x-admin-key: $KEY" "https://nmt.loveworldapis.com/api/kp/admin/installs?q=Main%20Hall"
curl -X POST -H "x-admin-key: $KEY" -H "content-type: application/json" -d '{"disabled":true,"reason":"Licence ended."}' https://nmt.loveworldapis.com/api/kp/admin/installs/<id>
curl -X PUT -H "x-admin-key: $KEY" -H "content-type: application/json" -d '{"minVersion":"0.2.0"}' https://nmt.loveworldapis.com/api/kp/admin/policy
curl -X POST -H "x-admin-key: $KEY" -H "content-type: application/json" -d '{"minutes":600}' https://nmt.loveworldapis.com/api/kp/admin/users/@pastor_ade/cloud
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `KP_KC_CLIENT_ID` | `NMM_KC_CLIENT_ID` | KingsChat client id (KingsPresenter's Web application) |
| `KP_KC_CLIENT_SECRET` | none | Its client secret, when KingsChat issued one (sent with the code) |
| `KP_KC_LEGACY_CLIENT_IDS` | none | Earlier client ids, comma separated: codes from app builds that still use one are exchanged with it (tried after `KP_KC_CLIENT_ID`) |
| `KP_SITE_URL` | `NMM_SITE_URL` | The site KingsChat sends people back to: `https://nmt.loveworldapis.com/api/kp` (this API's own callback) |
| `KP_KC_API_KEY` | `NMM_KC_API_KEY` | The KingsChat project's `api-key`, needed to read a profile: the project `KP_KC_CLIENT_ID` belongs to |
| `KP_API_KEY` | none | App key; unset, none is asked for |
| `KP_TOKEN_SECRET` | made once, kept in `settings` | Signs access tokens |
| `KP_ACCESS_TTL_SECONDS` / `KP_REFRESH_DAYS` | 3600 / 90 | Token lifetimes |
| `KINGSPRESENTER_DATABASE_URL` (or `KP_DATABASE_URL`) | NMM reporting's server (`NMM_DATABASE_URL` / `NMM_DB_*`), else `KP_DB_*` / `PCO_FN_DB_*`, with database `kingspresenter` | The database, as NMM reporting has `NMM_DATABASE_URL`: `postgres://user:password@host:5432/kingspresenter` |
| `KP_MEDIA_DIR` | `~/kingspresenter-media` | Media files (outside the project: pm2 restarts on changes inside it) |
| `KP_MAX_MEDIA_MB` | 2048 | Largest upload |
| `KP_RELAY_KEY` | none | Lets relays report sessions |
| `KP_RELAY_URL` | none | A relay to list when the `relays` table is empty |
| `OPENAI_API_KEY` | (the API's own) | The AI for recording summaries; unset, summaries answer `summaries_off` |
| `KP_SUMMARY_MODEL` | `gpt-4.1-mini` | The model that writes them |
| `KP_SUMMARY_MAX_CHARS` | 600000 | The longest transcript summarised |
| `KP_ADMIN_KEY` | none | The administrator's key for `/kp/admin/*`; unset: no admin routes |
| `KP_MAX_DEVICES` | 0 (no limit) | How many devices one account may be signed in on at once; a new device beyond it is refused (`device_limit`, 403). `/kp/me` and `/kp/devices` report `signedIn` and `max`. Read on each sign-in, so it can change without a restart |
| `KP_DEEPGRAM_API_KEY` | none | Deepgram's key for Cloud listening (Member rights or more): it stays here and makes the apps' 30-second tokens. Unset: `cloud_off` |
| `KP_DEEPGRAM_TOKEN_SECONDS` / `KP_CLOUD_TOKENS_PER_HOUR` | 30 / 60 | How long a token lasts (5–3600); how many streams one account may open an hour |
| `KP_CLOUD_MINUTES` | 120 | Cloud listening each account may use a month, in minutes, unless the administrator set its own (`/kp/admin/users/:id/cloud`). Read when asked: a change applies without a restart |
| `KP_UPDATE_UPLOAD_KEY` | none | Lets the build upload installers (the GitHub secret of the same name) |
| `KP_RELEASES_DIR` | `~/kingspresenter-releases` | The installers (outside the project, as the media) |
| `KP_MAX_RELEASE_MB` | 1024 | Largest installer |
| `KP_PUBLIC_URL` | this request's host | The API's public address up to its mount point, for the installer links (`https://nmt.loveworldapis.com/api`) |

Tests: `node --test test/kingspresenter.test.js` (a local Postgres; a stand-in KingsChat).
