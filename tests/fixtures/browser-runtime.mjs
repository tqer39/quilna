import { createServer } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
// The OS selects an unused loopback port. A race is a setup failure, never permission to reuse another server.
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
export async function assets() {
  const root = resolve("dist"),
    files = new Map();
  for (const file of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (file.isFile()) {
      const path = resolve(file.parentPath, file.name);
      files.set(
        "/" + path.slice(root.length + 1).replaceAll("\\", "/"),
        await readFile(path),
      );
    }
  }
  if (!files.has("/index.html"))
    throw Error("Build the browser app before running the runtime suite.");
  return (request) => {
    const path = new URL(request.url).pathname,
      key = path === "/" ? "/index.html" : path;
    if (!["GET", "HEAD"].includes(request.method) || !files.has(key))
      return new Response("", { status: 404 });
    return new Response(request.method === "HEAD" ? null : files.get(key), {
      headers: {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(key)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}
