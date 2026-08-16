# Google Drive S3 frontend integration docs

This project exposes a focused S3-compatible API on top of Google Drive. The live API reference is available from every enabled Worker deployment at [`/docs`](/docs), with the source OpenAPI document at [`/openapi.yaml`](/openapi.yaml).

## Start here

1. Configure the Worker with `CORS_ALLOWED_ORIGINS` for every browser origin that will upload or download objects.
2. Keep `SECRET_KEY` in a backend-for-frontend (BFF), not in browser code.
3. Let the BFF issue short-lived presigned URLs for a constrained bucket/key/method.
4. Upload or download through the presigned URL from the browser.

| Document | Purpose |
| --- | --- |
| [Integration guide](./integration-guide.md) | Browser upload, multipart upload, listing, CORS, and recommended architecture. |
| [Authentication](./authentication.md) | The precise AWS Signature V4 behavior enforced by the Worker. |
| [Limitations](./limitations.md) | Unsupported S3 features and Google Drive operational limits. |
| [`examples/bff-presign.ts`](./examples/bff-presign.ts) | A Workers BFF endpoint that creates short-lived PUT URLs. |
| [`examples/browser-upload.ts`](./examples/browser-upload.ts) | Single object upload from a browser. |
| [`examples/browser-multipart.ts`](./examples/browser-multipart.ts) | Strictly sequential browser multipart upload. |

## Browser security model

```text
Browser ── POST /presign ──> BFF (holds SECRET_KEY)
   │                              │
   └──── presigned S3 request ────┴──> S3 Google Drive Worker ──> Google Drive
```

The browser never receives `SECRET_KEY`. Presigned URLs must be short lived and scoped to the single object operation the browser needs.
