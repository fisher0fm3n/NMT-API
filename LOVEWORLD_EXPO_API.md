# LoveWorld Expo API

The account, booking and forms service behind the LoveWorld Expo website
(loveworldnation.online): KingsChat sign-in, exhibitors, SmartMeet one-on-one bookings,
registrations, passes and ad spaces paid in Espees, the team vote, sponsor enquiries and program
applications.
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
| `EXPO_SITE_URL` | The website, e.g. `https://loveworldnation.online` (for `/expo/config`'s redirectUri, and the links in KingsChat messages) |
| `EXPO_KC_MESSAGES` (on) | `off` stops the KingsChat messages about bookings (below). They also need `EXPO_KC_API_KEY` |
| `EXPO_KC_MESSAGES_URL` | KingsChat's messages API (default `https://connect.kingsch.at/developer/api/messages`); tests point it at a stand-in |
| `EXPO_KC_DEBUG` | `1` also logs each message's request body; every send's KingsChat answer is always logged (`[expo] KingsChat message …`) |
| `EXPO_API_KEY` | When set, every `/expo/*` call but `/expo/ping` must send `x-api-key` |
| `EXPO_ADMIN_KEY` | The `x-admin-key` for `/expo/admin/*` (unset: no admin routes) |
| `EXPO_AUTO_ADMINS` (pastorrita) | KingsChat usernames, comma-separated, made admins of the website's admin area each time they sign in; `""` turns it off. As it happens at every sign-in, removing one in the admin area lasts only until they sign in again: take them off this list too |
| `EXPO_TOKEN_SECRET` | Access-token signing key (unset: one is made once and kept in `settings`) |
| `EXPO_ACCESS_TTL_SECONDS` (3600), `EXPO_REFRESH_DAYS` (90) | Token lifetimes |
| `EXPO_START_DATE` (2026-11-09), `EXPO_END_DATE` (2026-11-15), `EXPO_UTC_OFFSET` (+01:00) | The event's days and clock |
| `EXPO_MEETING_MINUTES` (20), `EXPO_DAY_START_HOUR` (10), `EXPO_DAY_END_HOUR` (17), `EXPO_LUNCH_HOUR` (13), `EXPO_MAX_BOOKINGS_PER_DAY` (6) | SmartMeet slots |
| `EXPO_RESCHEDULE_CUTOFF_MINUTES` (15) | A visitor can move a meeting to another time until this many minutes before it starts |
| `EXPO_ESPEES_API_TOKEN` | The Expo's Espees merchant token (sent as `API-TOKEN`): passes are charged to the buyer's Espees wallet or card. Without it (or the KingsPass settings below) checkout answers `503 not_on_sale` |
| `EXPO_ESPEES_URL` | Espees' payments API (default `https://web.espees.org/api/externalpayments`: `/makepayment`, `/cardpayment`, `/transactionstatus`); tests point it at a stand-in |
| `EXPO_KINGSPASS_URL` | The KingsPass server: `https://kingspass.org` (`https://kingspass.org/api/` works too). Tickets are added at `https://kingspass.org/api/public/attendees` |
| `EXPO_KINGSPASS_EVENT_TOKEN` | The Expo event's KingsPass token, sent as `X-EVENT-TOKEN` |
| `EXPO_KINGSPASS_TEST2_TICKET` (2593) | The KingsPass ticket Test pass 2 (an admin-only 0.001 Espees pass) issues |
| `EXPO_CHECKOUT_REUSE_MINUTES` (30) | A pass bought again this soon after a purchase still to pay gets that purchase and its Espees page again; `0`: always a new one |
| `EXPO_PAY_DEBUG` | `1` also logs what is sent to Espees and KingsPass (PINs and card numbers hidden), and their answers in full (`[expo] Espees …`, `[expo] KingsPass …`); every answer's first 300 characters are always logged. Keys and tokens are never logged |
| `EXPO_OFFICIALS_VIDEO_URL` (the CloudFront link) | The officials' training video, which the website plays from there: `https://d1zx0zj5kmre28.cloudfront.net/videos/InShot_20261108_133320385.mp4` unless set. Its length is read from the file there (a few range requests, kept for six hours), so a new video needs only a new link |
| `EXPO_OFFICIALS_VIDEO_SECONDS` | The video's length to go by while it can't be read from the link (and none has been yet); unset, the video isn't offered until it can be |
| `EXPO_OFFICIALS_PASS_PERCENT` (80) | The officials' quiz pass mark: 80% of 25 questions is 20 right |
| `EXPO_VOTING` (on) | `off` closes the team vote: `POST /expo/votes` answers `503 voting_closed` and `GET /expo/votes` says `open: false`. Votes also need `EXPO_ESPEES_API_TOKEN` |
| `EXPO_VOTE_COUNTS` (on) | `off` keeps the vote's running totals to the admin: `GET /expo/votes` then gives each team's `votes`, and `total`, as null |
| `EXPO_AD_FILES_DIR` (`~/loveworld-expo-files/ad-artwork`) | Where ad proposals' artwork files (up to 200 MB each) are kept, each named by its artwork id. Keep it outside the app's folder: the process manager watches that folder, and `/uploads` in it is public |

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
| `already_voted` / `vote_pending` / `payment_in_progress` | 409 | The team vote: the person has voted (a vote can't be changed); their payment for a vote was taken, or may have been, and is being confirmed; it is still on its way to Espees |
| `voting_closed` / `bad_team` / `no_vote` | 503 / 400 / 404 | The team vote: closed (`EXPO_VOTING=off`) or not set up; not one of the teams; `/expo/votes/confirm` with no vote |
| `not_exhibitor` | 403 | `/expo/exhibitor/*`: the account is not on an exhibitor's team |
| `last_admin` | 409 | Taking admin away from the only admin account |
| `not_found` | 404 | |

## Endpoints

| Call | |
| --- | --- |
| `GET /expo/ping` | Alive; the number of accounts and exhibitors (no app key) |
| `GET /expo/config` | `{ kingschat: { clientId, loginUrl, redirectUri }, event: { start, end, days, utcOffset, meetingMinutes, dayStart, dayEnd, lunchHour, maxBookingsPerDay } }` |
| `POST /expo/auth/kingschat`, `/expo/auth/refresh`, `/expo/auth/logout` | Above |
| `GET /expo/me` | `{ user, counts: { bookings, registrations, applications }, exhibitor: { id, name, stand, smartMeet } \| null }` (`exhibitor`: the one the account runs, when the admin has put it on a team). `user.profileComplete` is false until `title`, `firstName`, `lastName`, `email`, `phone` and `country` are filled in, `christEmbassy` is answered, and, for a member of Christ Embassy, `zone` and `church` are filled in too (first and last name start from KingsChat's); the website asks for them before anything else. `user.christEmbassy`: true, false, or null if not yet asked (an account made before the question counts as a member if it has a zone and church) |
| `PATCH /expo/me { title?, firstName?, lastName?, email?, phone?, country?, christEmbassy?: true\|false, zone?, church?, organisation?, role? }` | `{ user }`: only the fields sent change. Someone who isn't a member of Christ Embassy needn't give a zone or church, but can (`bad_membership` if `christEmbassy` isn't true or false) |
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
| `POST /expo/passes/checkout { pass, days?: ["2026-11-10", …], expectedPrice?, payment: { method: "wallet", username, pin } \| { method: "card", cardNum, pin } }` | Buys a pass for the signed-in person, whose profile must be complete (`profile_incomplete`): the ticket holder's details come from it. KingsPass needs a zone and church for every attendee: for someone who hasn't given them (not a member of Christ Embassy), `lwexpo` and `lwexpo delegate` go to KingsPass in their place, and nowhere else. `pass`: `day` (10 Espees, one day), `three-day` (15, three different days), `week` (25), `vip` (100), `test` (0.001, admins only, KingsPass's test ticket 2582), `test-2` (0.001, admins only, KingsPass's test ticket 2593). Charges Espees there and then (`/makepayment` with `espeesAmount`, or `/cardpayment` with `amount`); the PIN goes to Espees and is never stored or logged, and only `@username` or the card's last four digits are kept (`payer`). Answers as soon as Espees has taken the payment: 201 `{ registration }` (`pending`, `paymentStatus: CHARGED`); the charge is then confirmed and the tickets issued in the background, as `/expo/passes/:id/confirm` also does. `already_paid` (409): the same pass for the same days was paid, or may have been, in the last ten minutes, so it isn't charged again. `payment_declined` (402, Espees' reason; nothing taken, the attempt kept as `cancelled` with `paymentError`), `payment_unavailable` (502, Espees unreachable; nothing taken), `payment_unknown` (502, no clear answer: kept `pending` with `paymentStatus: UNKNOWN` for the team to check; the buyer is told not to pay again), `payment_in_progress` (409, another payment of theirs is still with Espees), `missing_payment`, `bad_pass`, `bad_days`, `price_changed` (409), `not_on_sale` (503) |
| `POST /expo/passes/:id/confirm` | The person's own purchase brought up to date: `{ registration, checkError? }`. Asks Espees (`/transactionstatus`) about one it has charged (`status` "1", for its reference and full price, makes it `paid`), then adds a paid one's tickets on KingsPass (all added: `confirmed`, and the buyer gets a KingsChat message). Safe to call again: nothing is charged, and a ticket is added once. A purchase has `passDays`, `paymentMethod`, `payer`, `paymentStatus` (PROCESSING, CHARGED, PAID, DECLINED, UNKNOWN, or MISMATCH when confirmed for another amount), `paymentError`, `paidAt`, `issuedAt` and `tickets: [{ ticketId, day, status: to_issue\|issued\|failed }]` |
| `GET /expo/advertising/spaces` | `{ spaces: [{ id, name, size, price, kind, spots, taken, remaining, perProduct, held, sizes }] }`: the ad spaces (`lampposts`: Main Road Lamp Posts, 300 Espees a space, 31 spots, up to 2 for each product or service; `walkway-banners`: Walkway Banners, in three sizes, `4x2.5` (4 m wide × 2.5 m high, 1,500), `2.5x2.5` (2.5 m × 2.5 m, 1,200) and `2x2.5` (2 m × 2.5 m, 1,200), 29 spots and up to 5 for all the sizes together; `amphitheatre`: Amphitheatre Exterior, 3,000, 36 of which 11 are already gone, up to 4; `light-boxes`: Light Boxes, 1,500, 171 of which 101 are already gone, up to 4; `video`: Video Advert, 2,000 a video, 30 seconds, 1080 × 1920 HD MP4, `kind: "video"`, with no limit: `spots`, `remaining` and `perProduct` null; `test`: Test ad space, 0.001, 100, up to 10, `adminOnly`, listed and accepted for admin accounts only, for trying the whole flow with a real payment). `taken`: held by approved and paid proposals, plus the space's spots already gone outside the site (`reserved` in its settings); `sizes`: `[{ id, size, price }]` for a space booked in one of several sizes (then `size` lists them and `price` is the lowest), else null; `held` (signed in, else null): `[{ title, quantity }]`, what each of the person's products or services holds there, being reviewed, approved or paid (titles that differ only in spacing or capitals are the same product) |
| `GET /expo/advertising/proposals` | The signed-in person's proposals, newest first, and `spaces`: `{ proposals: [{ id, reference "AD-…", space, spaceName, size, sizeId, quantity, unitPrice, total, title, description, videoUrl, status: pending\|approved\|paid\|rejected\|cancelled, reviewNote, payUrl, paymentStatus, paymentMethod, payer, paymentError, createdAt, reviewedAt, paidAt, cancelledAt, cancelledBy, artworkUrl, artwork: [{ id, name, type, size, preview, complete, received }] }] }`. `payUrl` once approved. Each piece of artwork: its type and size (the file's), whether there's a review copy to look at (`preview`), and how much of the file has arrived (`received`; `complete` once all of it has) |
| `POST /expo/advertising/proposals { space, size?, quantity, title, description, videoUrl?, artworkUrl?, expectedPrice?, key? }` | 201 `{ proposal }` (`pending`); nothing is charged, and the person gets a KingsChat message that it's in. `key` (8 to 80 letters, digits, `-` and `_`, made by the website for each proposal): the same key sent again by the same person, a retry after a dropped connection, gives back the proposal it made (200, `repeated: true`) rather than a second one, with no second message. `title` is the product or service. A space with `sizes` needs one (`size`: its id, else `bad_size`), and is priced by it. `over_limit` (409): more than one product or service may hold of the space (the account's proposals with that title being reviewed, approved or paid count); a video advert (`space: "video"`) is one video (`quantity` 1, else `bad_quantity`) with the link to download it (`videoUrl`, an http or https address; `bad_video_link`) and no limit; a printed space's artwork may be given as a link too (`artworkUrl`: KingsCloud, Google Drive and the like, an http or https address; `bad_artwork_link`), told to the owner in the messages; `not_enough_spaces` (409): more than are left; `price_changed` (409); `bad_space`, `bad_size`, `bad_quantity`, `missing_fields` |
| `POST /expo/advertising/proposals/:id/artwork { name, data: base64, key? }` | 201 `{ artwork: { id, name, type, size } }`: one image for the person's own proposal while it's `pending` (the same `key` sent again gives back the image it stored, 200, rather than a second copy): JPG, PNG or WebP (by its content, else `bad_type`), up to 1.4 MB (`too_large`), six to a proposal (`too_many`). Kept in the database for the Expo team. The website now sends files (below) |
| `POST /expo/advertising/proposals/:id/files { name, size, key?, preview? }` | 201 `{ artwork, received: 0, chunkMax }`: starts one artwork file of `size` bytes, up to 200 MB (`too_large`, 413), for the person's own proposal while it's `pending`; its pieces follow. `preview`: for an image, a small review copy (base64 JPG, PNG or WebP, up to 1.4 MB, else `bad_preview`) for the team to look at. Six files and images to a proposal (`too_many`). The same `key` again gives back the file it started (200, `repeated: true`) with how much has arrived, so a send carries on where it stopped |
| `PUT /expo/advertising/proposals/:id/files/:fileId?offset=` (raw body, up to `chunkMax`, 8 MB) | `{ artwork, received, complete }`: the next piece of the file at `offset`, the bytes already there. A piece already stored (its answer lost) is taken again, not written twice; one that leaves a gap is `bad_offset` (409, with `received`: where to carry on from); past the size said, `too_long`. The first piece must show it's artwork, by its content: a JPG, PNG, WebP or TIFF image, a PDF (Illustrator files saved PDF-compatible are PDFs), a Photoshop (PSD) or PostScript (EPS) file, else `bad_type`. Kept on disk in `EXPO_AD_FILES_DIR`, not in the database |
| `POST /expo/advertising/proposals/:id/cancel` | The person withdraws their own proposal before it's paid (`not_cancellable` once paid, or while a payment is with Espees); they get a KingsChat message |
| `GET /expo/advertising/pay/:token` | The payment link's proposal, to whoever has the link (app key only): `{ proposal: { reference, space, spaceName, size, quantity, unitPrice, total, title, status, paymentStatus, paymentError, paidAt } }`, nothing about the account; 404 for a link that isn't valid |
| `POST /expo/advertising/pay/:token { expectedTotal?, payment: { method: "wallet", username, pin } \| { method: "card", cardNum, pin } }` | Pays an `approved` proposal in Espees there and then, as a pass is paid (the PIN goes to Espees and is never kept; `payer` is `@username` or the card's last four digits): 201 `{ proposal }` (`paymentStatus: CHARGED`), then confirmed in the background, as `/confirm` also does. `payment_declined` (402, Espees' reason; it can be paid again), `payment_unavailable` (502), `payment_unknown` (502: kept with `paymentStatus: UNKNOWN` for the team to check; not paid again), `payment_in_progress` (409), `already_paid`, `not_payable` (not approved), `price_changed`, `missing_payment`, `not_on_sale` (503: no Espees token) |
| `POST /expo/advertising/pay/:token/confirm` | `{ proposal, checkError? }`: a payment Espees has taken is checked with it (`status` "1", for its reference and the full total, makes it `paid`, and the owner gets a KingsChat message, once) |
| `GET /expo/votes` | The team vote, for anyone (the app key; a signed-in person's token when there is one): `{ open, price: 1, currency: "ESPEES", teams: [{ id, name, votes }], total, vote }`. The teams are `launchpad` (Launchpad), `wealth-liquefiers` (Wealth Liquefiers) and `dynamic` (Dynamic), each with its counted votes (`votes` and `total` are null when `EXPO_VOTE_COUNTS` is off). `vote` is the signed-in person's own, or null: `{ id, reference "VOTE-…", team, teamName, amount, status: pending\|counted, paymentStatus, paymentMethod, payer, createdAt, paidAt }`. A payment of theirs that Espees has taken but not yet confirmed is checked again as they look (at most every 15 seconds), so a vote paid for on a page that then closed still gets counted |
| `GET /expo/votes/me` | `{ vote }`: the signed-in person's vote, or null |
| `POST /expo/votes { team, expectedPrice?, payment: { method: "wallet", username, pin } \| { method: "card", cardNum, pin } }` | The signed-in person's one vote, for 1 Espee: 201 `{ vote }`. Espees is charged there and then, as for a pass (`/makepayment` or `/cardpayment`; the PIN goes to Espees and is never stored or logged), then asked to confirm the charge (`/transactionstatus`): `status` "1" for its reference and the full price makes the vote `counted` (`paymentStatus: PAID`), and the voter gets a KingsChat message. Until Espees confirms it the vote is `pending` (`CHARGED`) and isn't in any total. **Once and for good**: someone with a vote, or with a payment that was or may have been taken, is refused before anything is charged (`already_voted`, `vote_pending`, `payment_in_progress`, all 409), whichever team they ask for; nothing changes a vote's team. The database holds to it too: `team_votes` has unique indexes on the account and on its KingsChat identity, over the rows that aren't cancelled (so deleting the account and signing in again gives no second vote). `payment_declined` (402, Espees' reason) and `payment_unavailable` (502): nothing was taken, the attempt is kept as `cancelled`, and they can vote again, for any team. `payment_unknown` (502, no clear answer from Espees): kept `pending` with `paymentStatus: UNKNOWN` for the team to check, and the person is told not to pay again. `missing_payment`, `bad_team`, `price_changed` (409), `voting_closed` (503) |
| `POST /expo/votes/confirm` | The person's own vote brought up to date: `{ vote, checkError? }`. A payment Espees has taken is checked with it again, and counted once confirmed. Safe to call again: nothing is charged. `no_vote` (404) |
| `GET /expo/officials` | The signed-in person's officials' training: `{ training: { video: { available, seconds, url }, quiz: { questions, passMark, passPercent }, started, watchedSeconds, watchedAt, passedAt, certificate: { name, issuedAt } \| null, attempts: [{ score, total, passed, missed, at }] } }` (attempts newest first). `video.url` is the video's link (`EXPO_OFFICIALS_VIDEO_URL`); `available` is false, and `url` null, while its length can't be read |
| `POST /expo/officials/progress { seconds }` | How far into the video the person has watched: `{ training }`. Their furthest point moves on no faster than the video plays at 2× since their last report (plus 30 seconds), for the team to see; within 10 seconds of the end the video is watched (`watchedAt`). Watching isn't required for the quiz. `no_video` (503) |
| `GET /expo/officials/quiz` | Open from the start (the video isn't required first): `{ questions: [{ n, module, moduleName, text, options: [{ id: a\|b\|c\|d, text }] }], passMark, passPercent }`, each question's choices in a new order every time, without the answers |
| `POST /expo/officials/quiz { answers: { "1": "b", … }, key? }` | 201 `{ attempt: { score, total, passed, missed, at }, training }`: a go at the quiz, every question answered (`unanswered`, 400). `missed` names the questions got wrong, not their answers. `passMark` (20 of 25) or more passes (`passedAt`); as many goes as it takes, none after a pass (`already_passed`, 409). A first go starts the person's training if the video didn't. The same `key` sent again gives back the go it made (200, `repeated: true`), not a second |
| `POST /expo/officials/certificate { name }` | The name on the person's certificate, once they've passed (`not_passed`, 409): `{ training }`. Set once: another name after that is `name_set` (409); the same name again (a retry) is fine. `bad_name` (fewer than 2 characters); up to 80 |
| `POST /expo/sponsor/enquiries { name, email, organisation, role?, interest?, programs?, message? }` | 201 `{ reference "SP-…", id, createdAt }` |
| `POST /expo/programs/applications { program: eagles-nest\|qubators\|content-creative, name, email, organisation?, summary?, data?: {} }` | 201 `{ reference "EN-…" / "QB-…" / "CC-…", id, createdAt }` |
| `GET /expo/programs/applications` | The signed-in person's applications |
| `POST /expo/views { path }` | Counts a page view (the website sends one as each page is shown): `{ counted }`. Only the page and the day, on the event's clock, are kept, never anything about the visitor. A tidy page address only (`/`, `/programme/eagles-nest`: lowercase letters, digits and hyphens, up to four parts; a query or `#` is dropped), never `/admin`, `/api` or `/auth` (400 `bad_path`); after 300 different pages in a day, new ones aren't counted (`counted: false`). Needs the app key |

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
| `GET /expo/admin/stats` | Counts of users, exhibitors, bookings, registrations, enquiries, applications and counted team votes (`votes`) |
| `GET /expo/admin/page-views?days=` | Page views over the last `days` (30 by default, up to 366) to today: `{ from, to, total, days: [{ day, views }] (every day, none as 0), pages: [{ path, views }] (most viewed first), allTime: { views, since } }` |
| `GET /expo/admin/users?q=&exhibitor=&limit=&offset=` | `{ users, total, offset }`: accounts, newest first, each with `exhibitor: { id, name } \| null` and `admin`; `exhibitor=` is one exhibitor's team. `limit` (200 by default, up to 500) and `offset` page through them; `total` is how many match in all |
| `POST /expo/admin/users/:id { disabled?, reason?, admin? }` | `disabled` disables (signs out) or restores the account; `admin` grants or takes away the website's admin area (the last admin cannot be taken away: `last_admin`). `{ user, disabled, admin }` |
| `POST /expo/admin/users/:id/exhibitor { exhibitorId }` | Puts the account on that exhibitor's team (it then runs the exhibitor at `/expo/exhibitor`); `exhibitorId: null` takes it off. `{ user }` |
| `DELETE /expo/admin/users/:id` | Deletes the account and everything it made, all or nothing: its SmartMeet meetings (the slots free up; exhibitors are not messaged), passes, programme applications, sponsor enquiries, its message-log entries, its ad space proposals (and their artwork files on disk, once the rest has gone), its officials' training and quiz goes, and its sign-ins. Its team vote stays, counted, with no account on it (and its KingsChat identity has still voted). The last admin cannot be deleted (`last_admin`). Its tokens then get `401 account_deleted`. `{ deleted, removed: { bookings, registrations, applications, enquiries, messages, ads, quizAttempts, artworkFiles } }` |
| `GET /expo/admin/exhibitors` | Every exhibitor, with `availability`, `sort`, `active` and `team` (how many accounts run it) |
| `POST /expo/admin/exhibitors { id?, name, category, zone, stand, tagline, description, smartMeet, featured, meetingTopics, availability, logo, website, sort, active }` | Makes one (`id` from the name when not given; an existing id is updated) |
| `POST /expo/admin/exhibitors/import { exhibitors: [...] }` | Several at once, each made or updated by `id` (the shape of `scripts/expo-seed.json`) |
| `PUT /expo/admin/exhibitors/:id { …fields }` | Changes the fields given |
| `DELETE /expo/admin/exhibitors/:id` | Removes it (and its bookings) |
| `GET /expo/admin/bookings?exhibitor=&date=&limit=` | Every booking |
| `GET /expo/admin/notifications?booking=&limit=` | The KingsChat messages sent (booking messages and welcomes), newest first: `{ id, bookingId, reference, kind, user, recipientKcId, status: sent\|failed\|skipped, error, kcMessageId, body, createdAt, sentAt }` |
| `GET /expo/admin/registrations?pass=&status=`, `/expo/admin/enquiries`, `/expo/admin/applications?program=&status=` | The forms, newest first |
| `POST /expo/admin/registrations/:id/settle` | Any purchase brought up to date, as `/expo/passes/:id/confirm` (to retry tickets KingsPass refused). The admin's registrations also show each ticket's KingsPass `attendeeId`, `error` (KingsPass's reason, with its field errors, e.g. `400 phone_number: …`), `response` (its answer as it came, for a refused ticket) and `at` |
| `POST /expo/admin/registrations/:id { status: pending\|confirmed\|cancelled }`, `POST /expo/admin/enquiries/:id { status: new\|contacted\|closed }`, `POST /expo/admin/applications/:id { status: submitted\|shortlisted\|accepted\|declined }` | Moves one along |
| `GET /expo/admin/advertising?status=` | `{ proposals, spaces }`: every ad space proposal, newest first, each with `user: { id, username, name, email, phone, organisation }` and its artwork; `spaces` as `/expo/advertising/spaces` |
| `GET /expo/admin/advertising/artwork/:id` | A piece of artwork's image to look at: its review copy (or, sent before files, the image); 404 when it has none (a PDF) |
| `GET /expo/admin/advertising/artwork/:id/file` | The artwork file itself, as it was sent, to download (`Content-Disposition: attachment`); `not_complete` (409) until all of it has arrived |
| `POST /expo/admin/advertising/:id/approve { note? }` | A `pending` proposal approved, if its space still has room (`not_enough_spaces`; approvals take spots): its payment link (`payUrl`, `EXPO_SITE_URL/advertise/pay?link=<token>`) is made and sent to the owner on KingsChat, with the note |
| `POST /expo/admin/advertising/:id/reject { reason }` | Turned down (before it's paid), the reason sent to the owner on KingsChat (`missing_reason` without one) |
| `POST /expo/admin/advertising/:id/cancel { reason? }` | Cancelled (before it's paid; an approved one gives its spots back), the owner told on KingsChat |
| `POST /expo/admin/advertising/:id/settle` | A payment Espees has taken, checked with it again |
| `POST /expo/admin/advertising/:id/paid { note? }` | An `approved` proposal marked paid by hand (`paymentStatus: MARKED_PAID`), once the team has seen the payment in Espees; the owner is told as for any payment |
| `POST /expo/admin/advertising/:id/complimentary { note? }` | Booked free, for a sponsor whose category comes with ad space: a `pending` proposal (if its space still has room) or an `approved` one (not while a payment is with Espees) becomes `paid` with `paymentStatus: COMPLIMENTARY` and no payment link. It takes its spots as any booking does; the owner is told on KingsChat that there's nothing to pay. `not_complimentary` (409), `not_enough_spaces` (409) |
| `POST /expo/admin/advertising/:id/reopen` | An approved proposal whose payment had no clear answer (`UNKNOWN`, or stuck `PROCESSING`) opened for payment again, once the team has seen in Espees it was never taken |
| `GET /expo/admin/votes?status=&team=&q=&limit=&offset=` | The team vote: `{ open, countsPublic, price, teams: [{ id, name, votes }], totals: { counted, pending, cancelled, espees }, votes, total, offset }`. `teams`: each team's counted votes, whatever `EXPO_VOTE_COUNTS` says; `totals`: how many votes are counted, how many are still being paid for or checked, how many attempts were never paid, and the Espees taken for the counted ones. `votes`, newest first: `{ id, reference, team, teamName, amount, status: pending\|counted\|cancelled, paymentStatus (PROCESSING, CHARGED, PAID, DECLINED, UNKNOWN, MISMATCH, MARKED_PAID, REOPENED), paymentMethod, payer, paymentRef (Espees' reference), paymentError, paymentCheckedAt, createdAt, paidAt, cancelledAt, user: { id, username, name, email } \| null }` (`user` null for an account since deleted). `status=`, `team=` and `q=` (name, username, email, a vote's reference or Espees') narrow the list; `limit` (200 by default, up to 1000) and `offset` page through it; `total` is how many match |
| `POST /expo/admin/votes/:id/settle` | A vote's payment that Espees has taken, checked with it again: `{ vote, checkError? }` |
| `POST /expo/admin/votes/:id/paid { note? }` | A `pending` vote counted by hand (`paymentStatus: MARKED_PAID`), once the team has seen its payment in Espees (one without a clear answer, or confirmed for another amount); the voter is told on KingsChat. `not_pending` (409) for one already counted or never paid; `payment_in_progress` (409) while its charge is still on its way to Espees |
| `POST /expo/admin/votes/:id/reopen { note? }` | Lets the person vote again, once the team has seen in Espees that a `pending` vote's payment was never taken: the attempt is kept, `cancelled` (`paymentStatus: REOPENED`). `not_pending`, `payment_in_progress` as above. A counted vote can't be undone here |
| `GET /expo/admin/officials` | `{ officials, questions, quiz, video }`: everyone who has started the officials' training, newest first: `{ user: { id, username, name, email, phone }, startedAt, lastSeenAt, watchedSeconds, watchedAt, passedAt, certificate, attempts: [{ score, total, passed, at }] }` (oldest go first); each question `{ n, module, moduleName, text, answer, attempts, right }` (`right`: how many of every go got it right); `quiz: { questions, passMark, passPercent }`; `video: { available, seconds, url }` |

`availability` on an exhibitor (all optional): `{ "dayStart": 10, "dayEnd": 17, "slotMinutes": 20, "closedDates": ["2026-11-09"], "blocked": ["2026-11-10T11:00:00"] }`.

## KingsChat messages

**A pass bought.** When a purchase becomes `confirmed` (paid, and every ticket added on KingsPass),
the buyer gets a KingsChat message: the pass, its reference, the days, the ticket holder, the amount
paid, that the tickets are on KingsPass under their email, and links to My Expo and SmartMeet.
Recorded in `notifications` with `kind: "pass:confirmed"`; sent once per purchase.

**Ad spaces.** The owner of an ad space proposal gets a KingsChat message at every step: when it's
received (`ad:submitted`), approved, with the payment link and when print artwork is due (`ad:approved`; `EXPO_AD_ARTWORK_DEADLINE`, by default "Wednesday 4 November, 3pm (GMT+1)"), turned down, with the
reason (`ad:rejected`), paid (`ad:paid`, once), and cancelled by them or the team (`ad:cancelled`).
Each has the reference, the space and how many, the ad's title and the total; recorded in
`notifications` with the proposal's `ad_id`.

**A team vote.** When a vote is counted (Espees confirmed its payment, or the team counted it by
hand), the voter gets a KingsChat message: the team, the vote's reference, the Espee paid, that a
vote can't be changed, and a link to the teams. Recorded in `notifications` with
`kind: "vote:counted"`; sent once.

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
make it do so. The KingsChat usernames in `EXPO_AUTO_ADMINS` (pastorrita unless it's set) get the
flag as they sign in.

## The website

The Next.js site (loveworld-expo) talks to this service only from its own server (route
handlers under `/api/*` and `/auth/kingschat/*`), with `EXPO_API_URL` (this service up to
`/expo`, e.g. `https://nmt.loveworldapis.com/api/expo`) and `EXPO_API_KEY`. The person's
tokens live in HttpOnly cookies on the site; nothing here is called from the browser directly.
