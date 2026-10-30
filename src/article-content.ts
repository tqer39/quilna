import { Readability } from "@mozilla/readability";
import { sourceURL } from "./feed-discovery";
import type { DocumentReference } from "./source-document";
import { articleTextLimit } from "./document-format";
import {
  validSourceValidators,
  type SourceValidators,
} from "./http-validators.mjs";
import {
  articleSegments,
  serializeArticle,
  type ArticleCodeRange,
} from "./article-code";

export type ArticleContent = {
  text: string;
  url: string;
  title: string;
  language: string;
  fetchedAt: string;
  codeRanges?: ArticleCodeRange[];
  document?: DocumentReference;
};
export type ArticleTranslation = {
  text: string;
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
  codeRanges?: ArticleCodeRange[];
};
export { articleTextLimit } from "./document-format";

export function extractArticle(html: string, url: string): ArticleContent {
  sourceURL(url);
  if (html.length > 2_000_000)
    throw Error("記事が大きすぎるため取り込めませんでした。");
  // Never mount remote nodes. A template avoids subresource requests during parsing.
  const template = document.createElement("template");
  template.innerHTML = html;
  const language =
    /<html\b[^>]*\blang=["']([a-zA-Z-]+)["']/i.exec(html)?.[1] ?? "";
  template.content
    .querySelectorAll(
      "script,style,iframe,object,embed,img,picture,video,audio,source,link,meta,base,form,nav,footer,template,svg,math,[hidden],[aria-hidden='true']",
    )
    .forEach((n) => n.remove());
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      if (!["class", "id", "lang", "dir"].includes(attr.name))
        element.removeAttribute(attr.name);
    }
  }
  // Readability rewrites consecutive br elements into paragraphs. Preserve code
  // line breaks first, inside the inert fragment, before that prose cleanup.
  template.content
    .querySelectorAll("pre br, code br")
    .forEach((br) => br.replaceWith("\n"));
  const doc = document.implementation.createHTMLDocument("");
  doc.body.append(doc.importNode(template.content, true));
  doc.documentElement.lang = language;
  doc.title =
    doc.body.querySelector("title")?.textContent ||
    doc.body.querySelector("h1")?.textContent ||
    "";
  doc.body.querySelectorAll("title").forEach((n) => n.remove());
  let codeRanges: ArticleCodeRange[] = [];
  const parsed = new Readability(doc, {
    maxElemsToParse: 20000,
    charThreshold: 140,
    serializer: (node) => {
      const serialized = serializeArticle(node);
      codeRanges = serialized.codeRanges;
      return serialized.text;
    },
  }).parse();
  const text = parsed?.content;
  if (!text || text.length < 140)
    throw Error(
      "記事本文を見つけられませんでした。ログインやサイト側の制限がある場合は元の記事を開いてください。",
    );
  if (text.length > articleTextLimit)
    throw Error(
      "本文が20万文字を超えるため取り込めませんでした。元の記事を開いてください。",
    );
  return {
    text,
    url,
    title: parsed?.title?.slice(0, 500) || new URL(url).hostname,
    language: language.slice(0, 35),
    fetchedAt: new Date().toISOString(),
    codeRanges,
  };
}

export async function fetchArticle(
  url: string,
  previous?: { content: ArticleContent; validators?: SourceValidators },
): Promise<{
  content: ArticleContent;
  validators?: SourceValidators;
  notModified: boolean;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16000);
  try {
    const request = {
      url: sourceURL(url),
      discover: true,
      validators: previous?.validators,
    };
    // Preserve the local API's 4 KiB request boundary. Very long URLs/tags
    // fall back to a full fetch rather than weakening that limit.
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 4096)
      request.validators = undefined;
    const response = await fetch("/api/feeds/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok)
      throw Error(
        "本文を取得できませんでした。通信状態やサイト側の制限を確認し、再試行するか元の記事を開いてください。",
      );
    const result = await response.json();
    const validators =
      validSourceValidators(result.validators) &&
      result.validators.url === result.url
        ? result.validators
        : undefined;
    if (result.notModified === true) {
      if (
        !request.validators ||
        !previous?.validators ||
        !validSourceValidators(previous.validators) ||
        result.url !== previous.validators.url ||
        result.url !== previous.content.url ||
        result.html !== undefined ||
        (result.validators !== undefined && !validators)
      )
        throw Error(
          "更新確認の結果が保存済みの本文と一致しません。元の本文を保持しています。",
        );
      return {
        content: previous.content,
        validators: validators ?? previous.validators,
        notModified: true,
      };
    }
    if (typeof result.html !== "string" || typeof result.url !== "string")
      throw Error("このURLから記事のHTML本文を取得できませんでした。");
    return {
      content: extractArticle(result.html, result.url),
      validators,
      notModified: false,
    };
  } catch (error) {
    if (controller.signal.aborted)
      throw Error(
        "本文の取得が時間内に終わりませんでした。再試行してください。",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isLinkOnly(text: string): boolean {
  return !text.trim() || /^Article URL:\s*https?:\/\//i.test(text.trim());
}

interface TranslatorSession {
  translate(text: string): Promise<string>;
  destroy(): void;
}
interface TranslatorFactory {
  availability?(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<string>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    signal: AbortSignal;
    monitor: (monitor: EventTarget) => void;
  }): Promise<TranslatorSession>;
}
export function browserTranslator(): TranslatorFactory | undefined {
  return (globalThis as typeof globalThis & { Translator?: TranslatorFactory })
    .Translator;
}
export async function translateArticle(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  signal: AbortSignal,
  progress: (message: string) => void,
  automatic = false,
  codeRanges: ArticleCodeRange[] = [],
): Promise<ArticleTranslation> {
  const segments = articleSegments(text, codeRanges);
  const factory = browserTranslator();
  if (!factory)
    throw Error(
      "このブラウザは端末内翻訳に対応していません。外部翻訳サービスには送信していません。",
    );
  if (!sourceLanguage) throw Error("原文の言語を選択してください。");
  if (sourceLanguage === targetLanguage)
    throw Error("原文と翻訳先が同じ言語です。原文をそのまま読めます。");
  // Background imports may finish after transient user activation expires.
  // Only start those when this origin already has the language pair available.
  if (automatic && !navigator.userActivation?.isActive) {
    const availability = await factory.availability?.({
      sourceLanguage,
      targetLanguage,
    });
    signal.throwIfAborted();
    if (availability !== "available")
      throw Error(
        "この言語の翻訳データを準備するため、翻訳ボタンを押してください。",
      );
  }
  // Manual translation calls create before awaiting, retaining user activation.
  const translator = await factory.create({
    sourceLanguage,
    targetLanguage,
    signal,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        const loaded = (event as Event & { loaded: number }).loaded;
        progress(`翻訳データを準備中… ${Math.round(loaded * 100)}%`);
      });
    },
  });
  const abort = () => translator.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const chunks = segments.flatMap<{ text: string; code?: ArticleCodeRange }>(
      (segment) => {
        if (segment.code) return [{ text: segment.text, code: segment.code }];
        return segment.text.split(/(\n\s*\n)/).flatMap((paragraph) => {
          const pieces: string[] = [];
          let rest = paragraph;
          while (rest.length > 3000) {
            const prefix = rest.slice(0, 3000);
            const boundary = Math.max(
              prefix.lastIndexOf(" "),
              prefix.lastIndexOf("。"),
            );
            let end = boundary > 1500 ? boundary + 1 : 3000;
            if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
            pieces.push(rest.slice(0, end));
            rest = rest.slice(end);
          }
          if (rest) pieces.push(rest);
          return pieces.map((text) => ({ text, code: undefined }));
        });
      },
    );
    let translated = "";
    const translatedCode: ArticleCodeRange[] = [];
    for (const [index, chunk] of chunks.entries()) {
      signal.throwIfAborted();
      if (chunk.code) {
        translatedCode.push({
          start: translated.length,
          end: translated.length + chunk.text.length,
          block: chunk.code.block,
        });
        translated += chunk.text;
        continue;
      }
      if (!chunk.text.trim()) {
        translated += chunk.text;
        continue;
      }
      progress(`翻訳中… ${index + 1}/${chunks.length}`);
      const result = await translator.translate(chunk.text.trim());
      signal.throwIfAborted();
      if (!result.trim())
        throw Error("翻訳結果が空でした。再試行してください。");
      translated +=
        (chunk.text.match(/^\s*/)?.[0] ?? "") +
        result.trim() +
        (chunk.text.match(/\s*$/)?.[0] ?? "");
      if (translated.length > articleTextLimit * 2)
        throw Error("翻訳結果が大きすぎるため保存できません。");
    }
    if (translated.length > articleTextLimit * 2)
      throw Error("翻訳結果が大きすぎるため保存できません。");
    return {
      text: translated,
      sourceText: text,
      sourceLanguage,
      targetLanguage,
      codeRanges: translatedCode,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    translator.destroy();
  }
}
