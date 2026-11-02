import {
  paperQuery,
  paperSearchEndpoint,
  parsePaperSearch,
} from "./paper-search";
import {
  crossrefMetadata,
  paperDOI,
  paperEndpoint,
  paperFileLimit,
  paperSnapshot,
  parsePaper,
} from "./paper-format";

const rateKey = "quilna.crossref-rate.v1";
/** Share one conservative request slot across same-origin tabs; never automatically retry. */
export class PaperClient {
  constructor(
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
    private readonly now = Date.now,
  ) {}
  /** Fetch one manually requested observation under the shared rate/deadline boundary. */
  async lookup(input: string, signal: AbortSignal) {
    const doi = paperDOI(input);
    return this.request(
      paperEndpoint(doi),
      signal,
      async (raw, active) => {
        const metadata = crossrefMetadata(raw, doi);
        active.throwIfAborted();
        const snapshot = await paperSnapshot(
          metadata,
          new Date(this.now()).toISOString(),
        );
        return parsePaper(JSON.stringify(snapshot));
      },
      true,
    );
  }
  /** Search bibliographic facts only on explicit submission, sharing the DOI request boundary. */
  async search(input: string, signal: AbortSignal) {
    const query = paperQuery(input);
    return this.request(paperSearchEndpoint(query), signal, async (raw) =>
      parsePaperSearch(raw),
    );
  }
  /** Keep list and singleton transport, rate limits, validation and deadlines under one profile-wide lock. */
  private async request<T>(
    endpoint: string,
    signal: AbortSignal,
    consume: (raw: unknown, active: AbortSignal) => Promise<T>,
    single = false,
  ): Promise<T> {
    if (!navigator.locks)
      throw Error(
        "このブラウザでは論文DBへの要求調整を利用できません。対応するブラウザで開いてください。",
      );
    return navigator.locks.request("quilna.crossref", { signal }, async () => {
      signal.throwIfAborted();
      const previous = Number(localStorage.getItem(rateKey));
      if (Number.isFinite(previous) && previous > this.now())
        throw Error(
          `Crossrefへの次の確認は${new Date(previous).toLocaleString("ja-JP")}以降に試してください。自動で再送しません。`,
        );
      // Persist before dispatch so an interrupted tab cannot immediately repeat a request.
      localStorage.setItem(rateKey, String(this.now() + 1000));
      const deadline = AbortSignal.timeout(16000),
        combined = AbortSignal.any([signal, deadline]);
      let response: Response | undefined;
      try {
        response = await this.send(endpoint, {
          signal: combined,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        combined.throwIfAborted();
        const limit = Number(response.headers.get("x-rate-limit-limit")),
          interval = response.headers
            .get("x-rate-limit-interval")
            ?.match(/^(\d+(?:\.\d+)?)s$/),
          advertised =
            interval && limit > 0 ? (Number(interval[1]) * 1000) / limit : 0;
        let pause = Math.max(
          1000,
          Number.isFinite(advertised) ? advertised : 0,
        );
        const retry = response.headers.get("retry-after");
        if (retry) {
          const duration = /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - this.now();
          if (Number.isFinite(duration) && duration > pause) pause = duration;
        }
        if (response.status === 429 || response.status === 503)
          pause = Math.max(pause, 60_000);
        localStorage.setItem(rateKey, String(this.now() + pause));
        if (response.status === 404 && single)
          throw Error(
            "CrossrefにこのDOIの書誌情報がありません。他の登録機関のDOIもあります。保存済みの記録は保持しています。",
          );
        if (response.status === 429)
          throw Error(
            "Crossrefの要求上限です。しばらく待ってから手動で確認してください。自動で再送しません。",
          );
        if (!response.ok)
          throw Error(
            "Crossrefから書誌情報を取得できませんでした。保存済みの記録は保持しています。",
          );
        if (
          !response.headers.get("content-type")?.includes("application/json") ||
          !response.body
        )
          throw Error("Crossrefの応答形式を確認できません。");
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            combined.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > paperFileLimit)
              throw Error("書誌情報が取得サイズの上限を超えています。");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        combined.throwIfAborted();
        const result = await consume(raw, combined);
        combined.throwIfAborted();
        return result;
      } catch (error) {
        if (combined.aborted)
          throw Error(
            signal.aborted
              ? "書誌情報の確認を中止しました。保存済みの記録は保持しています。"
              : "Crossrefの応答が時間内に届きませんでした。もう一度確認できます。",
          );
        if (error instanceof TypeError || error instanceof SyntaxError)
          throw Error(
            "Crossrefへの接続または応答を確認できません。保存済みの記録は保持しています。",
          );
        throw error;
      } finally {
        await response?.body?.cancel().catch(() => {});
      }
    });
  }
}
