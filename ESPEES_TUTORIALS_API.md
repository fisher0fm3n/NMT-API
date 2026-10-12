# EspeesMax tutorials API

The tutorial videos shown as the **Learning path** on web.espees.org and in the EspeesMax app.
They live in Mongo (`NMT.espees_tutorials`), so a video can be added, replaced, reordered or
hidden without releasing either app. Code: `routes/espees_tutorials.js`. Tests:
`node --test test/espees_tutorials.test.js`.

Base URL: `https://nmt.loveworldapis.com/api` (the paths below follow it).

## Setting up

After deploying, load the original seven videos once:

```bash
curl -X POST https://nmt.loveworldapis.com/api/nmt/espees/admin/tutorials/seed
```

Seeding only adds videos whose slug is missing, so running it again never overwrites an edit.

## A tutorial

| Field             | Type                       | Notes                                                                 |
| ----------------- | -------------------------- | --------------------------------------------------------------------- |
| `slug`            | string                     | Required. Lowercase letters, numbers, single hyphens. Used in links (`?lesson=slug`). |
| `step`            | integer 1–999              | Display order and the "Step N" number. New videos go last if omitted. |
| `title`           | string ≤ 120               | Required.                                                             |
| `summary`         | string ≤ 240               | One line under the title on cards.                                    |
| `description`     | string ≤ 2000              | Paragraph beside the player.                                          |
| `outcomes`        | string[] ≤ 10              | "In this step you will" bullets.                                      |
| `relatedLinks`    | `{label, href}[]` ≤ 8      | `href` is a web app path (`/espees/buy`) or an `https://` URL. The mobile app maps paths to its own screens. |
| `poster`          | https URL                  | Required. 16:9 image, 1600×900 recommended.                           |
| `video`           | https URL                  | Required. MP4 (H.264) streams everywhere.                             |
| `durationSeconds` | number                     | Shown on cards. `0` hides it.                                         |
| `published`       | boolean                    | Default `true`. `false` hides the video from the apps but keeps it.   |
| `updatedAt`       | ISO date (read only)       |                                                                       |

## Public routes (no key)

### `GET /nmt/espees/tutorials`

Published videos in step order. Cached for 60 seconds, so an edit reaches the apps within a minute.

```json
{
  "status": true,
  "data": {
    "tutorials": [{ "slug": "before-you-begin", "step": 1, "title": "Before you begin", "...": "..." }],
    "count": 7,
    "updatedAt": "2026-10-12T19:40:00.000Z"
  }
}
```

### `GET /nmt/espees/tutorials/:slug`

One published video: `{ "status": true, "data": { "tutorial": { ... } } }`, or `404 not_found`.

## Managing the list (no key)

| Method & path                                  | Body                         | Does                                                       |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `GET /nmt/espees/admin/tutorials`              |                              | Every video, published or not.                             |
| `POST /nmt/espees/admin/tutorials`             | a full tutorial              | Adds a video. `409 slug_taken` if the slug exists.         |
| `PATCH /nmt/espees/admin/tutorials/:slug`      | any fields to change         | Changes only those fields (a new `slug` renames it).       |
| `DELETE /nmt/espees/admin/tutorials/:slug`     |                              | Removes the video. Use `published: false` to hide instead. |
| `PUT /nmt/espees/admin/tutorials/order`        | `{ "slugs": ["a", "b"] }`    | Listed videos become steps 1..n; the rest follow in order. |
| `POST /nmt/espees/admin/tutorials/seed`        |                              | Adds any of the original seven that are missing.           |

Errors are `{ "status": false, "error": "<code>", "message": "..." }`. A `400 invalid_tutorial`
also carries `fields`, naming each bad field and what is wrong with it.

### Examples

Replace a video file and its length:

```bash
curl -X PATCH https://nmt.loveworldapis.com/api/nmt/espees/admin/tutorials/buy-espees \
  -H "content-type: application/json" \
  -d '{"video":"https://d1zx0zj5kmre28.cloudfront.net/videos/espeesmax/BUY_ESPEES_V2.mp4","durationSeconds":52}'
```

Add a new step:

```bash
curl -X POST https://nmt.loveworldapis.com/api/nmt/espees/admin/tutorials \
  -H "content-type: application/json" \
  -d '{"slug":"pay-bills","title":"Pay bills","summary":"Airtime, data and electricity from your wallet.",
       "poster":"https://d1zx0zj5kmre28.cloudfront.net/videos/espeesmax/08_pay_bills.jpg",
       "video":"https://d1zx0zj5kmre28.cloudfront.net/videos/espeesmax/ESPEES_MAX_8_PAY_BILLS.mp4",
       "durationSeconds":40,"relatedLinks":[{"label":"Utilities","href":"/utilities"}]}'
```

Hide a video without deleting it:

```bash
curl -X PATCH https://nmt.loveworldapis.com/api/nmt/espees/admin/tutorials/pay-bills \
  -H "content-type: application/json" \
  -d '{"published":false}'
```

## How the apps use it

- **Web (web.espees.org):** the Next.js route `/api/tutorials` reads the public list, caches it
  for 60 seconds and falls back to the copy bundled with the site if this API cannot be reached.
- **Mobile app:** call `GET /nmt/espees/tutorials` directly (no key, no CORS on native), keep the
  last good reply on the device, and map `relatedLinks[].href` paths to app screens.
