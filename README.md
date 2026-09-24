# google-drive-s3

Use Cloudflare Workers to turn your Google Drive into S3 object storage at no extra cost.

## API documentation

With `ENABLE_DOCS` left enabled (the default), each deployment serves an interactive API reference at `/docs` and the raw OpenAPI 3.1 document at `/openapi.yaml`. Frontend-specific setup, authentication details, limitations, and runnable examples live in [`docs/`](./docs/README.md).

## About
This is a Workers script that converts the Google Drive API into an S3-compatible API. Turn your Google Drive into object storage at no extra cost!

### Does it work with the free Workers plan?
Signature verification uses the native Web Crypto API, and exceeding the 10ms CPU time limit is not normal usage. It also leverages JavaScript streams to handle large files.
However, this means that features such as hash verification are not implemented. This is because the memory limitations of Workers make it impossible to expand the entire uploaded file into memory.

### Does this violate the Google Terms of Service?
We believe that it does not violate the Terms of Service as long as you do not upload illegal content such as CSAM.
For the sake of your Google account, we strongly recommend using this in an environment where only you can upload.


## How to Deploy

### 1. Prepare a Google Drive API Refresh Token
You need Google API credentials and a Google Drive API refresh token. Either method below requires you to first create your own OAuth client (Google requires this per-app; a shared client cannot be scripted around it) — see the steps in either option.

**Option A: rclone**
Follow the rclone documentation to configure the client.  
https://rclone.org/drive/#making-your-own-client-id

**Option B: local script**
Run `pnpm get-refresh-token -- --client-id <ID> --client-secret <SECRET>` (see `scripts/get-google-refresh-token.mjs` for the Google Cloud Console setup steps — enabling the Drive API and creating a "Desktop app" OAuth client). It opens the consent screen, catches the redirect locally, and prints the values below directly.

> [!NOTE]
> When your Google API client is in "Testing" mode, the refresh token will expire after a certain period of time, so if you need to use it for a long period of time, be sure to switch the mode before authenticating with rclone.
> 
> You can complete the OAuth flow by skipping the very scary confirmation screen without submitting your app for validation.

Once complete, obtain the path to your rclone configuration file using `rclone config file`, read the configuration file, and note the following values:

```
[my-remote]
type = drive
# Use as GOOGLE_CLIENT_ID
client_id = myid.apps.googleusercontent.com
# Use as GOOGLE_CLIENT_SECRET
client_secret = SUPER_SECRET_TOKEN
scope = drive
token = {
  "access_token":"SECRET_ACCESS_TOKEN",
  "token_type":"Bearer",
  # ↓ Use this value as GOOGLE_REFRESH_TOKEN.
  "refresh_token":"SECRET_REFRESH_TOKEN",
  "expiry":"2026-01-08T12:37:09.064662+09:00",
  "expires_in":3599
}

```

### 2. Configure Cloudflare
From the Cloudflare dashboard, create two KV databases.  
Create a fork of this repository, edit `wrangler.json`, and modify the binding to the ID of your KV database.

Once complete, deploy Workers by running the following command:
```bash
wrangler deploy
```

### 3. Configure Secrets
Follow the documentation to configure the following secrets:  
https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard

| Key | Description |
| :--- | :--- |
| `ACCESS_KEY` | **Bootstrap only.** Seeded into the dashboard-managed access-key store on first use and superseded by it afterwards — manage keys from the dashboard's Integration page. |
| `SECRET_KEY` | **Bootstrap only.** Pairs with `ACCESS_KEY` for the initial seed; ignored once the store exists. |
| `REGION` | The region used by the S3 client. |
| `GOOGLE_CLIENT_ID`,  `GOOGLE_CLIENT_SECRET`,   `GOOGLE_REFRESH_TOKEN` | Google API credentials obtained from rclone. |
| `DASHBOARD_PASSWORD` | *(Optional)* Plaintext password for dashboard management API authentication. |
| `DRIVE_ROOT_FOLDER` | Root folder name in Google Drive where all buckets reside (e.g. `s3-storage`). Set in `wrangler.jsonc` vars or as a secret. |
| `CORS_ALLOWED_ORIGINS` | *(Optional)* Comma-separated exact browser origins, or `*`. Unset emits no CORS headers. |
| `ENABLE_DOCS` | *(Optional)* Set to `false` to disable `/docs` and `/openapi.yaml`; enabled by default. |
| `ENABLE_TIMING_LOGS` | *(Optional)* Set to `true` to log request duration, route shape, and status for S3/REST requests. Disabled by default. |
| `ENABLE_READ_CACHE` | *(Optional)* Set to `false` to disable the 5-minute folder/object lookup cache. Enabled by default. |

### 4. Enable Multipart Uploads

Large uploads require S3 Multipart Upload because Cloudflare's request-size limit applies before a request reaches the Worker. Multipart support uses one SQLite-backed Durable Object per upload and streams each admitted part directly into one Google Drive resumable session.

After deploying the `MultipartUploadDO` migration, change `ALLOW_MULTIPART` to `"true"` in `wrangler.jsonc`. Recommended AWS CLI settings:

```ini
[default]
s3 =
  multipart_chunksize = 16MB
  max_concurrent_requests = 3
request_checksum_calculation = when_required
```

Multipart parts must use consecutive numbers starting at 1 and are immutable after commit. The completed object's ETag defaults to Google Drive's real MD5 rather than S3's composite multipart ETag; set `ETAG_STYLE` to `"multipart"` only for clients that require the composite form. Existing objects may be re-evaluated once when their old Drive-ID ETag changes to MD5.

Google Drive's free tier has 15 GB total storage, and Google applies a 750 GB daily upload limit.


### 5. CORS Configuration
The Worker provides native, deny-by-default CORS handling. Set `CORS_ALLOWED_ORIGINS` to a comma-separated list of exact origins:

```ini
CORS_ALLOWED_ORIGINS=https://app.example.com,http://localhost:5173
```

Use `*` only for a public, credential-free integration. Leave the value unset to emit no CORS headers, preserving CLI-only behavior. Allowed origins receive preflight support for S3 methods and the browser-readable response headers `ETag`, `Content-Range`, `Content-Length`, `Last-Modified`, `Accept-Ranges`, and `x-amz-request-id`. Server-to-server clients do not need CORS: requests without an `Origin` retain their normal S3 response and receive no `Access-Control-*` headers. Exact origin allow-lists add the harmless `Vary: Origin` response header for cache correctness.

For browser uploads, keep `SECRET_KEY` in a BFF and give the browser short-lived presigned URLs. See the [frontend integration guide](./docs/integration-guide.md).

## Diagnosing Slow Reads

Temporarily set the Worker variable `ENABLE_TIMING_LOGS` to the string `true` and inspect Worker logs while reproducing listing and downloads. It is disabled when unset or set to `false`. Turn it off after collecting a representative sample.

Timing entries contain `method`, `status`, and `durationMs`, plus these grouping fields:

- `type=s3-timing`: `GET` with `hasKey=false` normally means listing; `GET` with `hasKey=true` means content download; `HEAD` with `hasKey=true` means metadata. Multipart queries also use these shapes, so exclude multipart traffic when comparing normal reads.
- `type=api-timing`: `route=objects` means listing for GET requests, `objects/content` means download, and `objects/metadata` means metadata. `buckets` and `status` identify dashboard reads; other API routes are grouped as `other`.

`durationMs` measures wall-clock time from Worker entry until the response is ready, including authentication, KV access, and upstream work. For streamed downloads it stops after Drive response headers arrive: it does not buffer or consume the body, measure completed transfer time, or include the client-to-Worker network latency. Compare client-side time to first byte and total download time separately.

S3 timing records also include `hasRange` and `stages` (milliseconds). Stages are recorded only when reached, including when they throw:

- `registry`: bucket registry lookup, including its cache miss work.
- `auth`: signature verification; absent for public reads.
- `token`: access-token lookup or refresh after authentication. A cold registry lookup may also obtain a token internally; that cost belongs to `registry`.
- `dispatch`: the requested operation, including Drive calls.

Successful S3 GET/HEAD object responses and REST content downloads include a `Server-Timing` header, even when timing logs are disabled. S3 logs copy it into `serverTiming`:

- `path`: resolve the parent folder hierarchy.
- `file`: search for the file and read its metadata.
- `media`: wait for the first Drive range of the download (at most 1 MiB); absent for HEAD. Larger downloads stream the remaining bytes as further Drive Range requests (growing up to 8 MiB each, with up to 4 fetched in parallel ahead of the stream) after the response has started, so `media` is time to first byte, not transfer time.

Downloads that need more than one Drive range also log one `type=drive-range-timing` record when the body finishes: `ranges` (Drive range requests), `bytes`, `slowestRangeMs` (longest wait for one range's headers), `streamMs` (total body time), and `waitMs`, the time the client received nothing because the next range was not ready yet. A high `waitMs` means Drive, not the client, is pacing the download.

These phase durations are inside `dispatch`, not extra time to add to it. The header contains fixed names and numeric durations only. It does not expose object keys or IDs. Listing and unsuccessful object reads have no phase header (`serverTiming=null`); use their stage durations instead. REST timing logs retain their existing schema. Gitea may not forward storage response headers to the browser, so inspect Worker logs for its S3 calls rather than relying on Gitea DevTools alone.

For slow Gitea Actions logs, enable timing temporarily and open the same completed job two or three times while viewing Worker logs. Compare GET, HEAD, Range usage, response status, and request count during each reproduction. A high `path`/`file` duration suggests repeated lookups; high `media` suggests latency waiting for Drive; a fast Worker response with a slow Gitea page calls for measuring transfer time, retries, and Gitea processing. Request count alone does not prove that calls are sequential. Compare against reading the same object directly from the Gitea host with its S3 client or a short-lived presigned GET URL. Do not change a presigned GET to HEAD with `curl -I`, and do not share credentials, tickets, or signed URLs in logs or support messages.

Compare p50/p95 separately by operation and status, including cold and repeated requests. Timing records use fixed labels and do not include bucket names, object keys, signed URLs, tickets, query strings, or response bodies. Existing error logs are unchanged. Auth, documentation, and OPTIONS routes do not emit these timing records.

Reads reuse the bucket folder ID from the existing registry, and cache nested folder IDs plus object metadata in `FOLDER_CACHE` for 5 minutes. Cache keys are scoped by parent folder or bucket/object key. PUT, DELETE, and multipart completion invalidate the affected object metadata; folder operations invalidate their folder entry. Direct changes in Google Drive may therefore remain stale for at most the cache TTL. Listing still reads live child entries, and downloads still read live media bytes. For file browsers, prefer a narrow `prefix` and `delimiter=/` instead of recursively listing an entire bucket. Pagination parameters remain unsupported as described in [limitations](./docs/limitations.md).
