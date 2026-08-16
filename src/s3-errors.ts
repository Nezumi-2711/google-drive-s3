import { escapeXml } from "./s3-xml";

export type S3ErrorCode = "AccessDenied" | "SignatureDoesNotMatch" | "RequestTimeTooSkewed" | "NoSuchKey" | "NoSuchUpload" | "InvalidPart" | "InvalidPartOrder" | "EntityTooLarge" | "MalformedXML" | "InvalidArgument" | "MethodNotAllowed" | "NotImplemented" | "SlowDown" | "InternalError";

const DEFAULT_MESSAGES: Record<S3ErrorCode, string> = {
    AccessDenied: "Access Denied",
    SignatureDoesNotMatch: "The request signature we calculated does not match the signature you provided.",
    RequestTimeTooSkewed: "The difference between the request time and the server's time is too large.",
    NoSuchKey: "The specified key does not exist.",
    NoSuchUpload: "The specified multipart upload does not exist.",
    InvalidPart: "One or more of the specified parts could not be found.",
    InvalidPartOrder: "The list of parts was not in ascending order.",
    EntityTooLarge: "Your proposed upload exceeds the maximum allowed object size.",
    MalformedXML: "The XML you provided was not well-formed or did not validate against our published schema.",
    InvalidArgument: "Invalid argument.",
    MethodNotAllowed: "The specified method is not allowed against this resource.",
    NotImplemented: "A header you provided implies functionality that is not implemented.",
    SlowDown: "Please reduce your request rate.",
    InternalError: "We encountered an internal error. Please try again.",
};

export class S3Exception extends Error {
    constructor(
        readonly code: S3ErrorCode,
        readonly status: number,
        message = DEFAULT_MESSAGES[code],
        readonly headers?: HeadersInit,
    ) {
        super(message);
    }
}

export function s3Error(code: S3ErrorCode, status: number, message = DEFAULT_MESSAGES[code], resource?: string, head = false, headers?: HeadersInit): Response {
    const requestId = crypto.randomUUID();
    const body = head ? null : `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message>${resource ? `<Resource>${escapeXml(resource)}</Resource>` : ""}<RequestId>${requestId}</RequestId></Error>`;
    const responseHeaders = new Headers(headers);
    responseHeaders.set("Content-Type", "application/xml");
    responseHeaders.set("x-amz-request-id", requestId);
    responseHeaders.set("Cache-Control", "no-transform");
    return new Response(body, { status, headers: responseHeaders });
}
