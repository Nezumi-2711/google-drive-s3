export interface Env {
    ACCESS_KEY: string;
    SECRET_KEY: string;
    REGION: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_REFRESH_TOKEN: string;
    AUTH_KV: KVNamespace;
    FOLDER_CACHE: KVNamespace;
    MPU: DurableObjectNamespace<import("./multipart-do").MultipartUploadDO>;
    ALLOWED_BUCKETS?: string;
    PUBLIC_READ_BUCKETS?: string;
    ALLOW_MULTIPART?: string;
    ETAG_STYLE?: "md5" | "multipart";
}

export interface GoogleDriveFile {
    id: string;
    name: string;
    mimeType: string;
    size: string;
    modifiedTime?: string;
    md5Checksum?: string;
}

export interface GoogleDriveSearchResponse {
    files?: GoogleDriveFile[];
}

export interface DriveUploadResult {
    id: string;
    name: string;
    mimeType?: string;
    size?: string;
    md5Checksum?: string;
}

export interface DriveDownloadResult {
    body: ReadableStream;
    contentType: string;
    size: number;
    id: string;
    md5Checksum?: string;
    status: number;
    contentRange?: string;
    contentLength?: string;
}

export interface DriveFileMetadata {
    id: string;
    mimeType: string;
    size: number;
    md5Checksum?: string;
}
