// Only read aggregate values from the local telemetry stack.
const health = await fetch("http://127.0.0.1:13133/", {
  signal: globalThis.AbortSignal.timeout(5000),
});
if (!health.ok) throw new Error(`Collector health: HTTP ${health.status}`);

const url = new URL("http://127.0.0.1:9090/api/v1/query");
url.searchParams.set("query", 'count(agent_session_info{project="quilna"})');
const response = await fetch(url, { signal: globalThis.AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(`Prometheus: HTTP ${response.status}`);
const data = await response.json();
const sessions = Number(data.data?.result?.[0]?.value?.[1]);
if (data.status !== "success" || !Number.isFinite(sessions) || sessions < 1) {
  throw new Error("No Quilna sessions indexed; check the session-indexer and its transcript mounts.");
}
console.log(`Collector healthy; Quilna sessions indexed: ${sessions}`);
console.log("Grafana: http://127.0.0.1:3000 (Agent Telemetry / Agent Sessions; project=quilna)");
