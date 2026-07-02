# usps-zip-api

Express REST API that:
1. Scrapes https://postalpro.usps.com/ZIP_Locale_Detail to find the current `.xls` download link (the file lives at a dated path like `/mnt/glusterfs/2026-05/ZIP_Locale_Detail.xls` that changes whenever USPS republishes it, so the link is never hardcoded).
2. Downloads and parses that spreadsheet with `xlsx`.
3. Auto-detects which columns hold the ZIP code and the state code (rather than relying on exact header names, since USPS has changed the layout before).
4. Caches the result in memory (12h TTL) and serves it grouped by state.

## Setup

```bash
npm install
npm start
```

Server runs on `http://localhost:3000` (override with `PORT` env var).

## Endpoints

| Method | Path                     | Description                                              |
|--------|--------------------------|------------------------------------------------------------|
| GET    | `/api/zip-codes`         | All ZIP codes grouped by state, with full state names       |
| GET    | `/api/zip-codes/meta`    | Cache info: source file URL, data vintage (year/month), fetch time, totals |
| GET    | `/api/zip-codes/states`  | Sorted list of `{ code, name }` for states in the dataset   |
| GET    | `/api/zip-codes/:state`  | ZIP codes + full name for one state, e.g. `/api/zip-codes/CA` |
| POST   | `/api/zip-codes/refresh` | Force a fresh scrape/download, bypassing the cache TTL      |

First request to any `GET /api/zip-codes*` route triggers the initial scrape+download automatically if the cache is empty or stale.

## Examples

```bash
curl http://localhost:3000/api/zip-codes/CA
```

```json
{
  "state": "CA",
  "name": "California",
  "count": 2322,
  "zipCodes": ["90001", "90002", "..."]
}
```

```bash
curl http://localhost:3000/api/zip-codes/meta
```

```json
{
  "sourceFileUrl": "https://postalpro.usps.com/mnt/glusterfs/2026-05/ZIP_Locale_Detail.xls",
  "dataVintage": { "year": 2026, "month": 5, "monthName": "May", "label": "May 2026" },
  "fetchedAt": "2026-07-02T19:50:00.000Z",
  "totalStates": 56,
  "totalZips": 37976,
  "debug": {
    "sheetUsed": "ZIP_DETAIL",
    "availableSheets": ["ZIP_DETAIL", "Unique_ZIP_DETAIL", "Other"],
    "zipColumnHeader": "DELIVERY ZIPCODE",
    "stateColumnHeader": "PHYSICAL STATE",
    "totalRowsInSheet": 44339
  }
}
```

`dataVintage` is parsed from the source file's dated URL path (USPS republishes the file under a path like `/mnt/glusterfs/2026-05/...`), so it reflects when USPS last updated the data, not when your server fetched it. If USPS ever ships the file without a dated path, `dataVintage` will be `null`.

`GET /api/zip-codes` returns each state enriched with its full name and count:

```json
{
  "CA": { "name": "California", "count": 2322, "zipCodes": ["90001", "..."] },
  "NY": { "name": "New York", "count": 1953, "zipCodes": ["..."] }
}
```

## Notes

- **robots.txt**: postalpro.usps.com's robots.txt disallows automated crawling. This is public reference data intended for download, but if you plan to run this on a schedule or in production, it's worth checking USPS's terms of use / reaching out to them, rather than assuming this is fine.
- The dataset is a few MB and a few tens of thousands of rows; parsing happens fully in memory, which is fine at this scale but wouldn't scale to much larger files without streaming.
- Cache is in-process memory only — restarting the server clears it (a fresh fetch happens on the next request). Swap `zipService`'s module-level `cache` object for Redis/a file/a DB if you need persistence across restarts or multiple instances.
