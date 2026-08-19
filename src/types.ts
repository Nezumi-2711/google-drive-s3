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
    DASHBOARD_PASSWORD?: string;
    ALLOWED_BUCKETS?: string;
    PUBLIC_READ_BUCKETS?: string;
    ALLOW_MULTIPART?: string;
    ETAG_STYLE?: "md5" | "multipart";
    CORS_ALLOWED_ORIGINS?: string;
    ENABLE_DOCS?: string;
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
    modifiedTime?: string;
    status: number;
    contentRange?: string;
    contentLength?: string;
}

export interface DriveFileMetadata {
    id: string;
    mimeType: string;
    size: number;
    md5Checksum?: string;
    modifiedTime?: string;
}

export interface DriveAboutUser {
    displayName?: string;
    emailAddress?: string;
}

export interface DriveAboutStorageQuota {
    limit?: string;
    usage?: string;
    usageInDrive?: string;
    usageInDriveTrash?: string;
}

export interface GoogleDriveAboutResponse {
    user?: DriveAboutUser;
    storageQuota?: DriveAboutStorageQuota;
}

export interface DriveAbout {
    user: {
        emailAddress: string | null;
        displayName: string | null;
    };
    storageQuota: {
        limit: number | null;
        usage: number;
        usageInDrive: number;
        usageInDriveTrash: number;
        free: number | null;
        percentUsed: number | null;
    };
}
