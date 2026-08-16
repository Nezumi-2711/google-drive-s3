# Authentication and Signature V4

The Worker accepts AWS Signature Version 4 in either form:

- an `Authorization: AWS4-HMAC-SHA256 …` header with `x-amz-date`; or
- a presigned request with `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-SignedHeaders`, and `X-Amz-Signature` query parameters.

The `Credential` access-key ID must equal the Worker's `ACCESS_KEY`; the signing key is derived from `SECRET_KEY`, `REGION`, service `s3`, and the `YYYYMMDD` request date.

## Presigned URL expiry

Query-authenticated requests require `X-Amz-Expires` from 1 through 604800 seconds (seven days). The Worker returns `403 AccessDenied` with `Request has expired` when it is missing, invalid, out of range, or its signed timestamp plus expiry is in the past.

BFFs should normally use a much shorter period such as five minutes.

## Header-authenticated requests

The Worker requires a valid `x-amz-date` and rejects a request when the server time differs from it by more than 15 minutes. This returns `403 RequestTimeTooSkewed`.

## Canonical request behavior

The canonical request is built from:

1. method;
2. URL path;
3. sorted query string (excluding `X-Amz-Signature` for presigned URLs);
4. the signed-header list and normalized values;
5. the signed-header list; and
6. `x-amz-content-sha256`, defaulting to `UNSIGNED-PAYLOAD`.

The Worker deliberately canonicalizes a signed `accept-encoding` header to `identity`. Cloudflare can rewrite the received value at the edge; S3 SDKs that sign this header use `identity` for this reason. Browser code must not sign `accept-encoding` because browser networking controls it.

Payload hashes are **not** verified. Browser and BFF clients should use `x-amz-content-sha256: UNSIGNED-PAYLOAD`; this is a deliberate streaming limitation, not an integrity guarantee.

## Public-read buckets

Buckets listed in `PUBLIC_READ_BUCKETS` permit unsigned `GET` and `HEAD` requests. All write operations still require valid Signature V4 authentication. `PUBLIC_READ_BUCKETS` must be a subset of `ALLOWED_BUCKETS`.

For a tested signing reference, see the `signed()` helper in [`test/s3.test.ts`](../test/s3.test.ts).
