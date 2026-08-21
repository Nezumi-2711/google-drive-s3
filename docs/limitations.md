# Limitations

This project is a narrow S3 compatibility layer. Design frontend features around the behavior below.

## Listing is not pageable

`max-keys`, `continuation-token`, and `marker` are ignored. The Worker scans at most 5000 Google Drive nodes and then sets `IsTruncated=true`; it does not provide a continuation token, so additional results cannot be requested. The XML value `MaxKeys=1000` is a fixed compatibility value, not the real scan limit.

Use narrow prefixes and `delimiter=/` for a file browser. Do not build an infinite-scrolling full-drive browser.

## No server-side rename or move

`CopyObject` and `UploadPartCopy` return `501 NotImplemented`. There is no server-side rename or move because both require copying. Implement rename/move as download, re-upload under the target key, then delete the original—subject to bandwidth, time, and error handling.

## Unsupported S3 features

- `ListBuckets`, `CreateBucket`, and `DeleteBucket` via S3 API (Bucket management and creation/deletion are handled via the dashboard or `/api/buckets` REST API).
- batch `DeleteObjects`
- object versioning, ACLs, object tags, lifecycle rules, and `x-amz-meta-*` user metadata
- CopyObject and UploadPartCopy
- discovering active multipart uploads: `ListMultipartUploads` always reports an empty list

Bucket `?acl`, `?versioning`, and `?location` requests are currently treated as regular bucket listing requests rather than errors. Do not rely on this accidental compatibility.

## Directories and objects

Directories are physical Google Drive folders created from object-key path segments. The Worker does not create zero-byte directory marker objects. An empty prefix can therefore exist as a Drive folder without an S3 marker object. Folder deletion via `/api/objects/folder` refuses non-empty folders by default, and supports atomic recursive deletion into Google Drive trash when `recursive=1` is provided (avoiding partial deletion via enumeration).

## Multipart behavior

Parts must be uploaded strictly in consecutive order beginning at part 1. Parts are immutable after they have committed. Default part size recommended and returned by the API is 8 MiB (aligned to Google Drive 256 KiB chunks). An incomplete upload expires after 24 hours. `ETAG_STYLE=md5` returns Google Drive's file MD5 for completed multipart objects; `ETAG_STYLE=multipart` is available only for clients that require an S3-style composite ETag.

## Quotas and plan limits

Google Drive's free tier has 15 GB total storage and a 750 GB/day upload limit. Cloudflare applies request-size limits before a request reaches the Worker; use multipart uploads for large browser uploads.
