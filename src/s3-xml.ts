import type { GoogleDriveFile } from "./types";

export function escapeXml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function generateListBucketResult(files: GoogleDriveFile[], bucket: string): string {
    const contents = files
        .map(
            (f) => `
    <Contents>
        <Key>${escapeXml(f.name)}</Key>
        <LastModified>${f.modifiedTime || new Date().toISOString()}</LastModified>
        <ETag>"${f.md5Checksum || f.id}"</ETag>
        <Size>${f.size || 0}</Size>
        <StorageClass>STANDARD</StorageClass>
    </Contents>`,
        )
        .join("");

    return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>${escapeXml(bucket)}</Name>
    <Prefix></Prefix>
    <MaxKeys>1000</MaxKeys>
    <IsTruncated>false</IsTruncated>
    ${contents}
</ListBucketResult>`;
}

export function initiateMultipartUploadResult(bucket: string, key: string, uploadId: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${escapeXml(bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${escapeXml(uploadId)}</UploadId></InitiateMultipartUploadResult>`;
}

export function completeMultipartUploadResult(bucket: string, key: string, etag: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>/${escapeXml(bucket)}/${escapeXml(key)}</Location><Bucket>${escapeXml(bucket)}</Bucket><Key>${escapeXml(key)}</Key><ETag>"${escapeXml(etag)}"</ETag></CompleteMultipartUploadResult>`;
}

export function listPartsResult(bucket: string, key: string, uploadId: string, result: { parts: Array<{ partNumber: number; size: number; etag: string; ts: number }>; nextMarker: number; truncated: boolean }): string {
    const parts = result.parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><LastModified>${new Date(part.ts).toISOString()}</LastModified><ETag>"${escapeXml(part.etag)}"</ETag><Size>${part.size}</Size></Part>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${escapeXml(bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${escapeXml(uploadId)}</UploadId><NextPartNumberMarker>${result.nextMarker}</NextPartNumberMarker><IsTruncated>${result.truncated}</IsTruncated>${parts}</ListPartsResult>`;
}

export function listMultipartUploadsResult(bucket: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${escapeXml(bucket)}</Bucket><KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker><NextKeyMarker></NextKeyMarker><NextUploadIdMarker></NextUploadIdMarker><MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`;
}

const PART_RE = /<Part\b[^>]*>([\s\S]*?)<\/Part>/g;
const NUM_RE = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/;
const ETAG_RE = /<ETag>\s*(?:&quot;|")?([^<"&]*)(?:&quot;|")?\s*<\/ETag>/;

export function parseCompleteMultipartUpload(xml: string): Array<{ partNumber: number; etag: string }> {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const match of xml.matchAll(PART_RE)) {
        const numberMatch = NUM_RE.exec(match[1]);
        const etagMatch = ETAG_RE.exec(match[1]);
        if (!numberMatch || !etagMatch || parts.length >= 10_000) throw new Error("MalformedXML");
        parts.push({ partNumber: Number(numberMatch[1]), etag: etagMatch[1].trim() });
    }
    if (parts.length === 0 && !/<CompleteMultipartUpload\b[^>]*>\s*<\/CompleteMultipartUpload>/.test(xml)) throw new Error("MalformedXML");
    return parts;
}
