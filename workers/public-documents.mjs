import { publicDocumentAccess } from "./public-document-access.mjs";
import { encode, hash } from "./crypto.mjs";

export const publicDocumentPaths = new Set([
  "/public/documents",
  "/api/public/documents",
]);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

function page(version, source, message, nonce) {
  const content = version?.content;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>共有記事を読む | Quilna</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;padding:24px;color:#182d29;background:#f4f6f3;font-family:system-ui,-apple-system,sans-serif;line-height:1.8}main{max-width:760px;margin:auto}header{margin-bottom:32px}h1{font-size:1.8rem;line-height:1.4}h2{font-size:1.6rem;line-height:1.5;overflow-wrap:anywhere}p{margin:12px 0}form{display:grid;gap:12px;margin:24px 0}input,button{font:inherit;padding:10px 12px;min-height:44px;border:1px solid #52645d;border-radius:8px}input{width:100%;min-width:0}button{background:#21685b;color:white;cursor:pointer}a{color:#21685b;overflow-wrap:anywhere}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #21685b;outline-offset:3px}.muted{color:#52645d}article{padding:24px;background:white;border:1px solid #d5ddd7;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.9}footer{margin-top:32px}@media(max-width:400px){body{padding:16px}article{padding:16px}}</style></head><body><main>
<header><a href="/public/documents">Quilna</a><h1>共有記事を読む</h1><p>公開が許可された保存済みの記事を、ログインせずに読めます。</p></header>
<form method="get" action="/public/documents"><label for="source">記事の元のURL</label><input id="source" name="url" type="url" maxlength="2048" required value="${escape(source)}" placeholder="https://example.com/article"><button type="submit">保存済みの記事を開く</button></form>
${message ? `<p role="status">${escape(message)}</p>` : ""}
${content ? `<article><h2>${escape(content.title || "記事")}</h2><p><a href="${escape(version.sourceURL)}" target="_blank" rel="noopener noreferrer">元の記事を開く</a></p><p class="muted">取得日時：${escape(content.fetchedAt)}。元サイトの最新状態と異なる場合があります。</p><pre>${escape(content.text)}</pre></article>` : ""}
<footer><p class="muted">ここでの閲覧は元サイトへの再取得を行いません。個人の保存・既読・タグ・メモは含まれません。</p><a href="/">自分のライブラリへ</a></footer></main></body></html>`;
}

/** 再検証を必須にして、保存済みの応答も現在の公開許可と削除状態を確認する。 */
export async function publicDocuments(request, env) {
  const url = new URL(request.url);
  const html = url.pathname === "/public/documents";
  let status = 200,
    version,
    publication,
    source = "",
    message = "",
    etag;
  try {
    if (
      url.origin !== env.APP_ORIGIN ||
      !["GET", "HEAD"].includes(request.method)
    ) {
      status = 404;
      throw Error("document-unavailable");
    }
    if (env.PUBLIC_DOCUMENTS_ENABLED !== "true") {
      status = 404;
      throw Error("document-unavailable");
    }
    if (
      [...url.searchParams.keys()].some((key) => key !== "url") ||
      url.searchParams.getAll("url").length > 1
    ) {
      status = 400;
      throw Error("document-request");
    }
    source = url.searchParams.get("url") ?? "";
    if (!source) {
      if (!html) {
        status = 400;
        throw Error("document-request");
      }
    } else {
      if (typeof env.PUBLIC_DOCUMENT_RATE_LIMITER?.limit !== "function")
        throw Error("document-unconfigured");
      // URLを変えても上限を回避できず、個人の識別子も保存しない共通枠。
      const quota = await env.PUBLIC_DOCUMENT_RATE_LIMITER.limit({
        key: "public-documents",
      });
      if (quota?.success !== true) {
        if (quota?.success !== false) throw Error("document-unconfigured");
        status = 429;
        throw Error("document-rate-limit");
      }
      const { documentIdentity, validDocumentVersion, sourceContent } =
        await import("../src/source-document.ts");
      const access = await publicDocumentAccess(env, source);
      const id = await documentIdentity(access.scope, access.url);
      const result = await env.DOCUMENTS.get(
        env.DOCUMENTS.idFromName(id),
      ).fetch(
        new Request("https://document.internal/public-read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: access.url, scope: access.scope }),
        }),
      );
      if (result.status !== 200) {
        await result.body?.cancel();
        throw Error(
          result.status === 404 ? "document-unavailable" : "document-failed",
        );
      }
      const value = await result.json();
      if (
        !validDocumentVersion(value) ||
        value.documentId !== id ||
        value.scope !== access.scope ||
        value.sourceURL !== access.url
      )
        throw Error("document-failed");
      // 同じ本文の版IDでも、再取得日時など配信する値の差を取りこぼさない。
      publication = {
        documentId: value.documentId,
        versionId: value.id,
        sourceURL: value.sourceURL,
        content: sourceContent(value.content),
      };
      const digest = await hash(publication);
      const current = await publicDocumentAccess(env, source);
      if (current.scope !== access.scope || current.url !== access.url)
        throw Error("document-unavailable");
      version = value;
      etag = `"${digest}"`;
    }
  } catch (error) {
    version = undefined;
    if (status === 200)
      status = error.message === "document-unavailable" ? 404 : 503;
    message =
      status === 429
        ? "アクセスが集中しています。少し待ってから開き直してください。"
        : status === 400
          ? "記事の元のURLを一つ入力してください。"
          : status === 404
            ? "公開されている保存済みの記事が見つかりません。元の記事を確認してください。"
            : "共有記事を確認できません。時間をおいて再度開いてください。";
  }
  const headers = {
    "Content-Type": html ? "text/html; charset=utf-8" : "application/json",
    "Cache-Control":
      !html && version ? "public, no-cache, must-revalidate" : "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (status === 429) headers["Retry-After"] = "60";
  if (!html && version) {
    headers.ETag = etag;
    const tags = request.headers
      .get("If-None-Match")
      ?.split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""));
    if (tags?.includes(etag) || tags?.includes("*"))
      return new Response(null, { status: 304, headers });
  }
  let body;
  if (html) {
    const nonce = encode(crypto.getRandomValues(new Uint8Array(18)));
    headers["Content-Security-Policy"] =
      `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
    body = page(version, source, message, nonce);
  } else
    body = JSON.stringify(
      version
        ? publication
        : {
            status:
              status === 429
                ? "document-rate-limit"
                : status === 400
                  ? "document-request"
                  : status === 404
                    ? "document-unavailable"
                    : "document-failed",
          },
    );
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers,
  });
}
