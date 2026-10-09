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

Library kinds: `services`, `songs`, `presentations`, `media`, `templates`, `settings`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `KP_KC_CLIENT_ID` | `NMM_KC_CLIENT_ID` | KingsChat client (the same one as NMM reporting) |
| `KP_SITE_URL` | `NMM_SITE_URL` | KingsChat's redirect site, as NMM reporting's |
| `KP_KC_API_KEY` | `NMM_KC_API_KEY` | Optional KingsChat `api-key` header |
| `KP_API_KEY` | none | App key; unset, none is asked for |
| `KP_TOKEN_SECRET` | made once, kept in `settings` | Signs access tokens |
| `KP_ACCESS_TTL_SECONDS` / `KP_REFRESH_DAYS` | 3600 / 90 | Token lifetimes |
| `DATABASE_URL` (or `KP_DATABASE_URL`) | NMM reporting's server (`NMM_DATABASE_URL` / `NMM_DB_*`), else `KP_DB_*` / `PCO_FN_DB_*`, with database `kingspresenter` | The database, e.g. `postgres://user:password@host:5432/kingspresenter` |
| `KP_MEDIA_DIR` | `~/kingspresenter-media` | Media files (outside the project: pm2 restarts on changes inside it) |
| `KP_MAX_MEDIA_MB` | 2048 | Largest upload |
| `KP_RELAY_KEY` | none | Lets relays report sessions |
| `KP_RELAY_URL` | none | A relay to list when the `relays` table is empty |

Tests: `node --test test/kingspresenter.test.js` (a local Postgres; a stand-in KingsChat).
