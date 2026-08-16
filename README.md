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
| `ACCESS_KEY` | Any access key used by the S3 client. |
| `SECRET_KEY` | A secure secret key used by the S3 client. |
| `REGION` | The region used by the S3 client. |
| `GOOGLE_CLIENT_ID`,  `GOOGLE_CLIENT_SECRET`,   `GOOGLE_REFRESH_TOKEN` | Google API credentials obtained from rclone. |
| `ALLOWED_BUCKETS` | Set the buckets allowed, separated by `,`. A directory with the bucket name will be created directly under Google Drive. |
| `PUBLIC_READ_BUCKETS` | *(Optional)* Buckets that allow unauthenticated GET/HEAD access without signature, separated by `,`. Write operations (PUT/POST/DELETE) still require authentication. Must be a subset of `ALLOWED_BUCKETS`. |
| `CORS_ALLOWED_ORIGINS` | *(Optional)* Comma-separated exact browser origins, or `*`. Unset emits no CORS headers. |
| `ENABLE_DOCS` | *(Optional)* Set to `false` to disable `/docs` and `/openapi.yaml`; enabled by default. |

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
