import { z } from "zod";

const description = z.object({
  language: z.string(),
  value: z.string().trim().min(1).max(1000),
});
const reply = z.object({
  success: z.literal(1),
  searchinfo: z.object({ search: z.string() }),
  search: z
    .array(
      z.object({
        id: z.string().regex(/^Q[1-9]\d{0,19}$/),
        display: z.object({
          label: description,
          description: description.optional(),
        }),
      }),
    )
    .max(3),
});

/** 検索語だけを固定のAPIへ渡す。リンクは応答内のURLを採用せず項目IDから組み立てる。 */
export async function searchWikidata(query: string, signal: AbortSignal) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({
    action: "wbsearchentities",
    type: "item",
    format: "json",
    language: "ja",
    uselang: "ja",
    limit: "3",
    origin: "*",
    search: query,
  }).toString();
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok || !response.body) throw Error("wikidata-unavailable");
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw Error("wikidata-size");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel();
  }
  const result = reply.parse(JSON.parse(raw));
  if (result.searchinfo.search !== query) throw Error("wikidata-query");
  return result.search.flatMap(({ id, display }) =>
    display.description?.language === "ja"
      ? [
          {
            id,
            label: display.label.value,
            description: display.description.value,
          },
        ]
      : [],
  );
}
