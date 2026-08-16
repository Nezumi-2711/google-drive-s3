import openApiSpec from "../docs/openapi.yaml";

export const OPENAPI_PATH = "/openapi.yaml";
export const DOCS_PATH = "/docs";

export function openApiResponse(): Response {
    return new Response(openApiSpec, {
        headers: {
            "Content-Type": "application/yaml; charset=utf-8",
            "Cache-Control": "public, max-age=300",
        },
    });
}

export function docsResponse(): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Google Drive S3 API reference</title>
</head>
<body>
  <script id="api-reference" data-url="${OPENAPI_PATH}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;

    return new Response(html, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
        },
    });
}
