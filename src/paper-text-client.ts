import { parsePaper, type PaperSnapshot } from "./paper-format";
import { parsePaperJATS } from "./paper-jats";
import {
  paperPMCID,
  paperTextEndpoint,
  paperXMLLimit,
} from "./paper-text-format";
const rateKey = "quilna.europepmc-rate.v1";
/** Retrieve one explicitly selected OA XML, with a profile-wide budget independent of account-library names. */
export class PaperTextClient {
  constructor(
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
    private readonly now = Date.now,
  ) {}
  /** Send only the PMCID to one fixed provider and validate identity/rights before publishing any paragraph. */
  async lookup(input: string, observation: PaperSnapshot, signal: AbortSignal) {
    signal.throwIfAborted();
    const pmcid = paperPMCID(input),
      paper = await parsePaper(JSON.stringify(observation));
    if (!navigator.locks)
      throw Error(
        "このブラウザでは公開本文の要求調整を利用できません。対応するブラウザで開いてください。",
      );
    return navigator.locks.request("quilna.europepmc", { signal }, async () => {
      signal.throwIfAborted();
      const previous = Number(localStorage.getItem(rateKey));
      if (Number.isFinite(previous) && previous > this.now())
        throw Error(
          `Europe PMCへの次の確認は${new Date(previous).toLocaleString("ja-JP")}以降に試してください。自動で再送しません。`,
        );
      localStorage.setItem(rateKey, String(this.now() + 1000));
      const combined = AbortSignal.any([signal, AbortSignal.timeout(16000)]);
      let response: Response | undefined;
      try {
        response = await this.send(paperTextEndpoint(pmcid), {
          signal: combined,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          cache: "no-store",
          headers: { Accept: "application/xml" },
        });
        combined.throwIfAborted();
        let pause =
          response.status === 429 || response.status === 503 ? 60000 : 1000;
        const retry = response.headers.get("retry-after");
        if (retry) {
          const duration = /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - this.now();
          if (Number.isFinite(duration) && duration > pause) pause = duration;
        }
        localStorage.setItem(rateKey, String(this.now() + pause));
        if (response.status === 429)
          throw Error(
            "Europe PMCの要求上限です。しばらく待ってから手動で確認してください。自動で再送しません。",
          );
        if (response.status === 404)
          throw Error(
            "Europe PMCでこのPMCIDの公開本文を取得できません。保存済みの記録は保持しています。",
          );
        if (!response.ok)
          throw Error(
            "Europe PMCから公開本文を取得できません。保存済みの記録は保持しています。",
          );
        const type = response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (
          !type ||
          !["application/xml", "text/xml", "application/jats+xml"].includes(
            type,
          ) ||
          !response.body
        )
          throw Error("Europe PMCの本文応答形式を確認できません。");
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            combined.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > paperXMLLimit)
              throw Error(
                "公開本文が取得サイズの上限2,000,000バイトを超えています。",
              );
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
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        combined.throwIfAborted();
        const source = await parsePaperJATS(
          raw,
          pmcid,
          paper,
          new Date(this.now()).toISOString(),
        );
        combined.throwIfAborted();
        return source;
      } catch (error) {
        if (combined.aborted)
          throw Error(
            signal.aborted
              ? "公開本文の確認を中止しました。保存済みの記録は保持しています。"
              : "Europe PMCの応答が時間内に届きませんでした。もう一度確認できます。",
          );
        if (error instanceof TypeError || error instanceof SyntaxError)
          throw Error(
            "Europe PMCへの接続または本文応答を確認できません。保存済みの記録は保持しています。",
          );
        throw error;
      } finally {
        await response?.body?.cancel().catch(() => {});
      }
    });
  }
}
