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
`https://accounts.kingschat.online/log-in?clientId=<KP_KC_CLIENT_ID>&redirect_uri=<KP_SITE_URL>/auth/kingschat/callback`
(the same client and site as NMM reporting), takes the `authCode` KingsChat sends
back, and posts it here. An existing KingsChat `accessToken` may be sent instead.

```json
{ "status": true, "accessToken": "<JWT, 1 h>", "refreshToken": "<opaque, 90 days>",
  "expiresIn": 3600, "deviceId": "<uuid>",
  "user": { "id", "kcId", "username", "name", "avatar", "email", "phone", "createdAt" } }
```

The access token is an HS256 JWT (`sub` = user id, `dev` = device id). Relays check
it by calling `GET /kp/me`. `POST /kp/auth/refresh { refreshToken }` returns a new
pair; each refresh token works once. `POST /kp/auth/logout { refreshToken }` ends
that device's sign-in.

`/kp/auth/kingschat/callback` (GET or POST, no app key) is a redirect a phone may
give KingsChat instead: it exchanges the code and returns a page that hands the
tokens to the app's sign-in view (`window.ReactNativeWebView.postMessage`,
`{ type: "kp-auth", status, accessToken, refreshToken, user, … }`).

## Responses

Success: `{ "status": true, … }`. Failure: `{ "status": false, "error": "<code>", "message": "<for people>" }`.

| Error | HTTP | When |
| --- | --- | --- |
| `unauthorized_api_key` | 401 | Missing or wrong `x-api-key` |
| `no_token` / `invalid_token` | 401 | No or expired access token, used-up refresh token |
| `missing_code` | 400 | No `code` or `accessToken` |
| `kc_exchange_failed` / `kc_profile_failed` / `kc_no_identity` | 502 | KingsChat refused |
| `kc_not_configured` | 500 | `KP_KC_CLIENT_ID` (or `NMM_KC_CLIENT_ID`) unset |

## Endpoints

| Call | |
| --- | --- |
| `GET /kp/ping` | Alive; the number of accounts |
| `GET /kp/config` | `{ kingschat: { clientId, loginUrl, redirectUri }, relays: [{ name, url, region }] }` |
| `POST /kp/auth/kingschat`, `/kp/auth/refresh`, `/kp/auth/logout` | Above |
| `GET /kp/me` | `{ user }` |
| `GET /kp/devices` | The computers and phones signed in: `{ devices: [{ id, name, kind, lastSeen, signedIn, current }] }` |
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

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `KP_KC_CLIENT_ID` | `NMM_KC_CLIENT_ID` | KingsChat client (the same one as NMM reporting) |
| `KP_SITE_URL` | `NMM_SITE_URL` | KingsChat's redirect site, as NMM reporting's |
| `KP_KC_API_KEY` | `NMM_KC_API_KEY` | Optional KingsChat `api-key` header |
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
| `KP_UPDATE_UPLOAD_KEY` | none | Lets the build upload installers (the GitHub secret of the same name) |
| `KP_RELEASES_DIR` | `~/kingspresenter-releases` | The installers (outside the project, as the media) |
| `KP_MAX_RELEASE_MB` | 1024 | Largest installer |
| `KP_PUBLIC_URL` | this request's host | The API's public address up to its mount point, for the installer links (`https://nmt.loveworldapis.com/api`) |

Tests: `node --test test/kingspresenter.test.js` (a local Postgres; a stand-in KingsChat).
