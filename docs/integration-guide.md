# Frontend integration guide

## Architecture

Use a backend-for-frontend (BFF) as the trust boundary:

```text
Browser → BFF (holds ACCESS_KEY + SECRET_KEY, issues presigned URLs) → S3 Google Drive Worker → Google Drive
```

Never put `SECRET_KEY` in browser code, a static site, or a public environment variable. The browser receives only a short-lived presigned URL for one method and object key.

## Enable browser access

Configure the Worker with an explicit allow-list of web origins:

```ini
CORS_ALLOWED_ORIGINS=https://app.example.com,http://localhost:5173
```

Set it to `*` only for a genuinely public, credential-free integration. Leaving it unset emits no CORS headers. The Worker exposes `ETag`, `Content-Range`, `Content-Length`, `Last-Modified`, `Accept-Ranges`, and `x-amz-request-id`, so browser code can inspect the headers that form the effective S3 response payload.

### Server-to-server compatibility

CORS does not restrict non-browser clients. `Access-Control-*` headers are emitted only when a request has an allowed `Origin`; a CLI, Dokploy, rclone, aws-cli, or other service request with no `Origin` keeps its normal S3 status and body. With an exact origin allow-list, responses also include `Vary: Origin`, including requests without an `Origin`, so shared caches cannot replay a no-origin object response to a browser. S3 clients ignore this cache-control metadata.

An `OPTIONS` request with no `Origin`, or a preflight from a disallowed origin, receives the same bare `204` as a CORS-disabled Worker. A disallowed `Origin` never changes the underlying S3 result—it simply receives no `Access-Control-*` headers.

## Presign in the BFF

Use `@aws-sdk/s3-request-presigner` and send a limited expiry. The Worker validates `X-Amz-Expires` and rejects URLs after their signing time plus that value.

```ts
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
});

const url = await getSignedUrl(
    client,
    new PutObjectCommand({
        Bucket: "assets",
        Key: "uploads/avatar.png",
        ContentType: "image/png",
    }),
    { expiresIn: 300 },
);
```

Keep the `ContentType` in the command and send precisely that same `Content-Type` from the browser. It becomes the Drive `mimeType`. A non-simple content type causes a preflight request, which is why the Worker CORS configuration is necessary.

## Upload one object

Use `Blob`, `File`, `ArrayBuffer`, or a typed array as the body. This lets the browser provide a known body length. Do **not** use a `ReadableStream` unless the BFF signs `x-amz-decoded-content-length` and the browser sends it: multipart part uploads require `Content-Length` or `x-amz-decoded-content-length`.

```ts
const response = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
});

if (!response.ok) throw new Error(await response.text());
const etag = response.headers.get("ETag");
```

`ETag` is readable only when the request `Origin` is configured in `CORS_ALLOWED_ORIGINS`.

## Multipart upload

Cloudflare request limits mean a single PUT is best kept below roughly 100 MB. For larger files, have the BFF initiate the upload, issue a presigned URL for each part, and complete the upload after the browser returns all ETags.

Use 16 MB parts as a practical baseline. Upload parts **strictly sequentially starting at 1**. The Worker waits up to 20 seconds for an earlier part; out-of-order work then receives `503 SlowDown`. Requests more than 64 part numbers ahead are rejected immediately.

1. BFF signs `POST /bucket/key?uploads` and starts the multipart upload.
2. BFF issues a signed `PUT` URL for part 1; browser uploads it and records the `ETag`.
3. Repeat one part at a time for parts 2 through $n$.
4. BFF signs `POST /bucket/key?uploadId=…`; browser sends the `CompleteMultipartUpload` XML body containing the sequential part numbers and ETags.

See [`examples/browser-multipart.ts`](./examples/browser-multipart.ts) for a complete browser-side loop.

## Build a file browser

List with `prefix` and `delimiter=/`:

```text
GET /assets?prefix=photos/&delimiter=/
```

Files appear in `Contents`; immediate child folders appear as `CommonPrefixes`. Google Drive directories are physical folders, not zero-byte marker objects. Read [limitations](./limitations.md) before designing pagination or rename/move features.
