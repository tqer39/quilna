import { DOMParser } from "linkedom/worker";
import { extractArticleDocument } from "../src/article-extraction.ts";
import { validDocumentContent } from "../src/source-document.ts";
import { validSourceValidators } from "../src/http-validators.mjs";
import { cloudFeedURL, fetchCloudFeed } from "./feed-fetch.mjs";

// Server-owned acquisition only: no request body, cookies, browser DOM, or HTML
// returned to the reader. Authorization/sharing policy belongs to the caller.
export function createArticleLoader({ blockedHosts = [], send = fetch } = {}) {
  return async (sourceURL, previous) => {
    const url = cloudFeedURL(sourceURL, blockedHosts).href;
    if (
      previous !== undefined &&
      (!validDocumentContent(previous?.content) ||
        (previous.validators !== undefined &&
          (!validSourceValidators(previous.validators) ||
            previous.validators.url !== previous.content.url)))
    )
      throw Error("document-previous");
    const result = await fetchCloudFeed(url, {
      blockedHosts,
      send,
      allowHTML: true,
      validators: previous?.validators,
    });
    if (result.notModified === true) {
      if (!previous?.validators || result.url !== previous.content.url)
        throw Error("document-response");
      return result;
    }
    if (typeof result.html !== "string") throw Error("document-not-html");
    // A DOM-only parser has no script execution or subresource loading. Never
    // install its classes on globalThis: other concurrent requests share it.
    const doc = new DOMParser().parseFromString(
      "<!doctype html><html><head><title></title></head><body></body></html>",
      "text/html",
    );
    const content = extractArticleDocument(
      result.html,
      result.url,
      doc,
      (fragment) => {
        // HTML parsing discards one LF immediately inside these elements. LinkeDOM
        // retains it; normalize only this parser, before Readability/code ranges.
        for (const element of fragment.querySelectorAll(
          "pre,textarea,listing",
        )) {
          const first = element.firstChild;
          if (first?.nodeType === 3 && first.textContent.startsWith("\n"))
            first.textContent = first.textContent.slice(1);
        }
      },
    );
    if (!validDocumentContent(content)) throw Error("document-response");
    return {
      content,
      ...(result.validators ? { validators: result.validators } : {}),
    };
  };
}
