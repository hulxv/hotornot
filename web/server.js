// Local stand-in for Vercel: static files from public/, and /api/<path> to the GET or POST
// exported by api/<path>.js, called with a Web Request exactly as Vercel calls it.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const API_DIR = join(ROOT, "api");
const API_ROUTE = /^\/api\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)$/;
const MAX_BODY_BYTES = 1 << 20;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pbf": "application/x-protobuf",
  ".gz": "application/gzip",
  ".sqlite": "application/vnd.sqlite3",
  ".map": "application/json; charset=utf-8",
};

const isFile = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveApi(req, res, url, route) {
  const file = join(API_DIR, `${route}.js`);
  if (!(await isFile(file))) return sendText(res, 404, "Not found");
  const routeModule = await import(pathToFileURL(file).href);
  const handler = routeModule[req.method === "HEAD" ? "GET" : req.method];
  if (typeof handler !== "function") {
    const allowed = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof routeModule[m] === "function");
    return sendText(res, 405, "Method not allowed", { allow: allowed.join(", ") });
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
  }
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readRequestBody(req);
    if (body === null) return sendText(res, 413, "Request body too large");
  }

  const response = await handler(new Request(url, { method: req.method, headers, body }));
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  if (!response.body || req.method === "HEAD") return res.end();
  await pipeline(Readable.fromWeb(response.body), res);
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed", { allow: "GET, HEAD" });
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, "Bad request");
  }
  if (path.endsWith("/")) path += "index.html";
  const file = resolve(PUBLIC_DIR, `.${path}`);
  const hidden = path.split("/").some((part) => part.startsWith("."));
  if (hidden || !file.startsWith(PUBLIC_DIR + sep) || !(await isFile(file))) return sendText(res, 404, "Not found");
  const { size } = await stat(file);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": size,
  });
  if (req.method === "HEAD") return res.end();
  await pipeline(createReadStream(file), res);
}

/** @type {import("node:http").RequestListener} */
async function handle(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    const route = API_ROUTE.exec(url.pathname);
    if (route) await serveApi(req, res, url, route[1]);
    else if (url.pathname.startsWith("/api/")) sendText(res, 404, "Not found");
    else await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(`${req.method} ${url.pathname}:`, error);
    if (!res.headersSent) sendText(res, 500, "Internal server error");
    else res.destroy();
  }
}

export function createAppServer() {
  return createServer(handle);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServer().listen(port, () => console.log(`HotOrNot on http://localhost:${port}`));
}
