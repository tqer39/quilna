import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("A valid browser validation port is required");
}
let server;
try {
  server = await createServer({
    root,
    configFile: resolve(root, "vite.config.mjs"),
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  // Only this child process can emit the readiness marker, after its own bind.
  // An unrelated HTTP 200 (including a Vite SPA fallback) cannot satisfy it.
  console.log(`QUILNA_BROWSER_SERVER_READY ${port}`);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }
} catch (error) {
  await server?.close();
  console.error(error);
  process.exitCode = 1;
}
