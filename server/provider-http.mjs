// No global fetch, key lookup, endpoint setting, retry, redirect or error-body logging.
// send is an explicitly injected HTTP boundary; current tests inject only network mocks.
export async function postJson(
  send,
  url,
  headers,
  body,
  signal,
  maximumBytes = 65536,
) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 192000
  )
    throw Error("transport-unavailable");
  if (typeof send !== "function" || signal?.aborted)
    throw Error("transport-unavailable");
  let response;
  try {
    response = await send(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
  } catch {
    throw Error("transport-unknown");
  }
  if (
    response.status !== 200 ||
    response.redirected ||
    (response.url && response.url !== url)
  ) {
    await response.body?.cancel();
    throw Error("provider-unknown");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("provider-unknown");
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw Error("provider-unknown");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    await reader.cancel().catch(() => {});
    throw Error("provider-unknown");
  } finally {
    reader.releaseLock();
  }
}
export function checkOptions(options, supportedModel) {
  if (
    options.model !== supportedModel ||
    options.retries !== 0 ||
    options.store !== false ||
    options.tools?.length !== 0 ||
    !Number.isSafeInteger(options.inputTokens) ||
    options.inputTokens < 1 ||
    options.inputTokens > 8000 ||
    !Number.isSafeInteger(options.outputTokens) ||
    options.outputTokens < 1 ||
    options.outputTokens > 2000 ||
    !Number.isSafeInteger(options.tokenCountMargin) ||
    options.tokenCountMargin < 0 ||
    options.tokenCountMargin > 2000 ||
    options.tokenCountTermsConfirmed !== true ||
    options.signal?.aborted
  )
    throw Error("transport-unconfigured");
}
export function secretHeaders(secret, provider) {
  if (typeof secret !== "string" || !/^[\x21-\x7e]{10,500}$/.test(secret))
    throw Error("credential-unconfigured");
  return provider === "openai"
    ? { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }
    : {
        "Content-Type": "application/json",
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
      };
}
export function tokenCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000)
    throw Error("usage-unconfirmed");
  return value;
}
