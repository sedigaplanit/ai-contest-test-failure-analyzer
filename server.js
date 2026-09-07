import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const port = Number(process.env.PORT || 4173);
const defaultAmplifyBaseUrl = "https://amplify.planittesting.com/openai";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  try {
    if ((request.url ?? "").startsWith("/api/amplify/")) {
      await handleAmplifyProxy(request, response);
      return;
    }

    await serveAppAsset(request, response);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected server error" }));
  }
});

server.listen(port, () => {
  console.log(`Local app server running at http://localhost:${port}`);
});

async function handleAmplifyProxy(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const requestBody = await readRequestBody(request);
  const upstreamBaseUrl = sanitizeBaseUrl(request.headers["x-amplify-base-url"]);
  const upstreamUrl = `${upstreamBaseUrl}/chat/completions`;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": String(request.headers["content-type"] || "application/json"),
      Authorization: String(request.headers.authorization || ""),
    },
    body: requestBody,
  });

  const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
  const contentType = upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8";

  response.writeHead(upstreamResponse.status, { "Content-Type": contentType });
  response.end(upstreamBody);
}

async function serveAppAsset(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `localhost:${port}`}`);
  const relativePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const normalizedPath = path.normalize(relativePath).replace(/^([.][.][/\\])+/, "");
  let filePath = path.join(distDir, normalizedPath);

  try {
    const fileBuffer = await readFile(filePath);
    response.writeHead(200, { "Content-Type": getContentType(filePath) });
    response.end(fileBuffer);
    return;
  } catch {
    filePath = path.join(distDir, "index.html");
  }

  const fallback = await readFile(filePath);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(fallback);
}

function getContentType(filePath) {
  return contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function sanitizeBaseUrl(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    return defaultAmplifyBaseUrl;
  }

  return value.replace(/\/$/, "");
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}
