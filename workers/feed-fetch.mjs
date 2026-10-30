// Production requires global_fetch_strictly_public: the Workers platform keeps
// global fetch on the public Internet. This is not the Node DNS-pinning adapter.
// Never replace this fetch with a private-origin/VPC binding.
import {
  conditionalHeaders,
  responseValidators,
  validSourceValidators,
} from "../src/http-validators.mjs";
export function cloudFeedURL(value, blockedHosts = []) {
  if (typeof value !== "string" || value.length > 2048) throw Error("feed-url");
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      url.hostname,
    ) ||
    /\.(localhost|local|internal|test|invalid|example|onion|arpa|home|lan|localdomain)$/i.test(
      url.hostname,
    ) ||
    blockedHosts.some(
      (host) => url.hostname === host.toLowerCase().replace(/\.$/, ""),
    )
  )
    throw Error("feed-host-unsupported");
  url.hash = "";
  return url;
}

export async function fetchCloudFeed(
  value,
  {
    blockedHosts = [],
    send = fetch,
    timeout = 12000,
    allowHTML = false,
    validators,
  } = {},
) {
  if (
    validators !== undefined &&
    (!allowHTML || !validSourceValidators(validators))
  )
    throw Error("feed-validators");
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(Error("feed-timeout"));
  }, timeout);
  try {
    return await Promise.race([
      deadline,
      (async () => {
        let url = cloudFeedURL(value, blockedHosts);
        for (let redirects = 0; redirects <= 3; redirects++) {
          const condition = conditionalHeaders(url.href, validators);
          const response = await send(url.href, {
            redirect: "manual",
            signal: controller.signal,
            headers: {
              ...condition,
              Accept:
                "application/atom+xml, application/rss+xml, application/xml, text/xml" +
                (allowHTML ? ", text/html, application/xhtml+xml" : ""),
            },
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get("Location");
            if (!location) throw Error("feed-redirect");
            url = cloudFeedURL(new URL(location, url).href, blockedHosts);
            continue;
          }
          const received = responseValidators(
            url.href,
            response.headers.get("ETag"),
            response.headers.get("Last-Modified"),
          );
          if (response.status === 304) {
            await response.body?.cancel();
            if (!Object.keys(condition).length) throw Error("feed-response");
            return {
              url: url.href,
              notModified: true,
              ...(received ? { validators: received } : {}),
            };
          }
          const html = /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
            response.headers.get("Content-Type") ?? "",
          );
          if (
            response.status !== 200 ||
            !response.body ||
            (!(allowHTML && html) &&
              !/^(application\/(rss\+xml|atom\+xml|xml)|text\/(xml|plain))(;|$)/i.test(
                response.headers.get("Content-Type") ?? "",
              ))
          ) {
            await response.body?.cancel();
            throw Error("feed-response");
          }
          const charset =
            /charset=["']?([^;\s"']+)/i.exec(
              response.headers.get("Content-Type") ?? "",
            )?.[1] ?? "utf-8";
          const reader = response.body.getReader();
          try {
            const decoder = new TextDecoder(charset, { fatal: true });
            let xml = "",
              size = 0;
            for (;;) {
              const { done, value: chunk } = await reader.read();
              if (done) break;
              size += chunk.byteLength;
              if (size > 2_000_000) throw Error("feed-size");
              xml += decoder.decode(chunk, { stream: true });
            }
            xml += decoder.decode();
            if (!xml.trim() || (!html && /<!\s*(DOCTYPE|ENTITY)/i.test(xml)))
              throw Error("feed-xml");
            return {
              url: url.href,
              [html ? "html" : "xml"]: xml,
              ...(html && received ? { validators: received } : {}),
            };
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        throw Error("feed-redirect");
      })(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
