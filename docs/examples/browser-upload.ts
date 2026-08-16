interface PresignedPut {
    url: string;
    method: "PUT";
    headers: { "Content-Type": string };
    expiresIn: number;
}

async function getPresignedPut(key: string, contentType: string): Promise<PresignedPut> {
    const response = await fetch("/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, contentType, operation: "put" }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json<PresignedPut>();
}

export async function uploadFile(file: File, key: string): Promise<string | null> {
    const signed = await getPresignedPut(key, file.type || "application/octet-stream");
    const response = await fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: file,
    });
    if (!response.ok) throw new Error(`Upload failed: ${await response.text()}`);

    // Requires CORS_ALLOWED_ORIGINS to include this page's exact origin.
    return response.headers.get("ETag");
}
