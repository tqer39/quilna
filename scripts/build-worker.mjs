import { build } from "esbuild";
import { checkWorkerConfigs } from "./check-worker-config.mjs";
const errors = checkWorkerConfigs(process.cwd());
if (errors.length) throw Error(errors.join("\n"));
await build({
  entryPoints: ["workers/index.mjs"],
  outfile: ".local-state/worker-build/index.mjs",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["cloudflare:workers"],
  logLevel: "silent",
});
