import { safeArticleLink } from "./article-structure";
import { readerIcon } from "./reader-icons";
import { button, el } from "./ui";
const iconData =
  /^data:image\/(png|jpeg|gif|webp|x-icon);base64,[A-Za-z0-9+/=]+$/;
const icons = new Map<string, Promise<string | null>>();
let iconQueue = Promise.resolve();
async function sourceRequest(url: string, icon = false, signal?: AbortSignal) {
  const response = await fetch("/api/feeds/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      ...(icon ? { icon: true } : { discover: true }),
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(16000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) throw Error("リンク先を取得できませんでした。");
  return response.json();
}
function loadIcon(url: string): Promise<string | null> {
  const origin = new URL(url).origin;
  const existing = icons.get(origin);
  if (existing) return existing;
  // One small request at a time; icons cannot occupy every article-fetch slot.
  const pending = iconQueue.then(async () => {
    try {
      const data = await sourceRequest(origin, true);
      return typeof data.icon === "string" &&
        data.icon.length < 90000 &&
        iconData.test(data.icon)
        ? data.icon
        : null;
    } catch {
      return null;
    }
  });
  iconQueue = pending.then(() => {});
  icons.set(origin, pending);
  if (icons.size > 40) icons.delete(icons.keys().next().value!);
  return pending;
}
const iconTargets = new Map<Element, { url: string; host: HTMLElement }>();
const observer =
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (entry.isIntersecting) {
              observer!.unobserve(entry.target);
              const target = iconTargets.get(entry.target);
              iconTargets.delete(entry.target);
              if (target)
                void loadIcon(target.url).then((data) => {
                  if (!data) return;
                  const img = el("img");
                  img.src = data;
                  img.alt = "";
                  img.width = 16;
                  img.height = 16;
                  img.decoding = "async";
                  img.referrerPolicy = "no-referrer";
                  img.addEventListener(
                    "error",
                    () => target.host.replaceChildren(readerIcon("site")),
                    { once: true },
                  );
                  target.host.replaceChildren(img);
                });
            }
        },
        { rootMargin: "80px" },
      );
export function siteIcon(url: string) {
  queueMicrotask(() => {
    for (const target of iconTargets.keys())
      if (!target.isConnected) {
        observer?.unobserve(target);
        iconTargets.delete(target);
      }
  });
  const host = el("span", undefined, "rss-site-icon");
  host.setAttribute("aria-hidden", "true");
  host.append(readerIcon("site"));
  const safe = safeArticleLink(url);
  if (safe?.startsWith("https:")) {
    iconTargets.set(host, { url: safe, host });
    observer?.observe(host);
  }
  return host;
}
let dialog: HTMLDivElement | undefined,
  generation = 0,
  controller: AbortController | undefined,
  closeTimer: ReturnType<typeof setTimeout> | undefined,
  trigger: HTMLElement | undefined;
function cancelClose() {
  clearTimeout(closeTimer);
}
function closePreview() {
  cancelClose();
  controller?.abort();
  generation++;
  if (dialog) dialog.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
}
function deferClose() {
  cancelClose();
  closeTimer = setTimeout(closePreview, 250);
}
const previews = new Map<
  string,
  { title: string; description: string; url: string }
>();
function ensureDialog() {
  if (dialog) return dialog;
  dialog = el("div", undefined, "rss-link-preview");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "リンク先のプレビュー");
  dialog.id = "rss-link-preview";
  dialog.hidden = true;
  dialog.addEventListener("pointerenter", cancelClose);
  dialog.addEventListener("pointerleave", deferClose);
  dialog.addEventListener("focusin", cancelClose);
  dialog.addEventListener("focusout", deferClose);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dialog && !dialog.hidden) {
      if (dialog.contains(document.activeElement))
        trigger?.focus({ preventScroll: true });
      closePreview();
    }
  });
  window.addEventListener("scroll", closePreview, { passive: true });
  window.addEventListener("resize", closePreview);
  document.addEventListener("pointerdown", (e) => {
    if (
      dialog &&
      !dialog.contains(e.target as Node) &&
      !e.composedPath().includes(trigger!)
    )
      closePreview();
  });
  document.body.append(dialog);
  return dialog;
}
export async function showLinkPreview(url: string, source?: HTMLElement) {
  const safe = safeArticleLink(url);
  if (!safe) return;
  cancelClose();
  trigger?.setAttribute("aria-expanded", "false");
  trigger = source;
  trigger?.setAttribute("aria-expanded", "true");
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal,
    token = ++generation;
  const host = ensureDialog(),
    title = el("h2", "リンク先のプレビュー"),
    close = button("閉じる", () => {
      trigger?.focus({ preventScroll: true });
      closePreview();
    }),
    status = el("p", "読み込み中…");
  status.setAttribute("role", "status");
  const destination = el("a", new URL(safe).hostname);
  destination.href = safe;
  destination.target = "_blank";
  destination.rel = "noopener noreferrer";
  destination.prepend(siteIcon(safe));
  host.replaceChildren(close, title, destination, status);
  host.hidden = false;
  const box = source?.getBoundingClientRect();
  host.style.left = `${Math.max(12, Math.min(box?.left ?? 12, window.innerWidth - Math.min(380, window.innerWidth - 24) - 12))}px`;
  host.style.top = `${Math.max(12, Math.min((box?.bottom ?? 0) + 8, window.innerHeight - 300))}px`;

  try {
    if (!safe.startsWith("https:"))
      throw Error(
        "HTTPのリンクはプレビューできません。元のリンクから開けます。",
      );
    let preview = previews.get(safe);
    if (!preview) {
      const data = await sourceRequest(safe, false, signal);
      if (
        typeof data.html !== "string" ||
        data.html.length > 2_000_000 ||
        typeof data.url !== "string" ||
        !safeArticleLink(data.url)
      )
        throw Error("プレビュー情報を読み取れませんでした。");
      const template = document.createElement("template");
      template.innerHTML = data.html;
      const meta = (name: string) =>
        Array.from(template.content.querySelectorAll("meta"))
          .find(
            (m) =>
              (
                m.getAttribute("property") ||
                m.getAttribute("name") ||
                ""
              ).toLowerCase() === name,
          )
          ?.getAttribute("content")
          ?.trim();
      preview = {
        title: (
          meta("og:title") ||
          template.content.querySelector("title")?.textContent ||
          new URL(data.url).hostname
        ).slice(0, 300),
        description: (
          meta("og:description") ||
          meta("description") ||
          "説明文は提供されていません。"
        ).slice(0, 700),
        url: data.url,
      };
      previews.set(safe, preview);
      if (previews.size > 40) previews.delete(previews.keys().next().value!);
    }
    if (token !== generation || signal.aborted || host.hidden) return;
    title.textContent = preview.title;
    status.textContent = preview.description;
    host.append(el("p", new URL(preview.url).hostname, "muted"));
  } catch (error) {
    if (token !== generation || signal.aborted) return;
    status.textContent = `プレビューできませんでした。${(error as Error).message}`;
    host.append(button("再試行", () => void showLinkPreview(safe, trigger)));
  }
}
export function decorateArticleLink(anchor: HTMLAnchorElement, url: string) {
  anchor.prepend(siteIcon(url));
  const tools = el("span", undefined, "rss-link-tools"),
    root = tools.attachShadow({ mode: "open" });
  const preview = button("", () => void showLinkPreview(url, preview));
  preview.append(readerIcon("preview"));
  preview.setAttribute(
    "aria-label",
    `リンク先をプレビュー：${new URL(url).hostname}`,
  );
  preview.title = "リンク先をプレビュー";
  preview.part.add("preview-button");
  root.append(preview);
  anchor.after(tools);
  for (const target of [anchor, preview]) {
    target.setAttribute("aria-controls", "rss-link-preview");
    target.setAttribute("aria-expanded", "false");
    let hover: ReturnType<typeof setTimeout> | undefined;
    target.addEventListener("pointerenter", (event) => {
      if ((event as PointerEvent).pointerType !== "mouse") return;
      cancelClose();
      hover = setTimeout(() => {
        if (target.isConnected) void showLinkPreview(url, target);
      }, 400);
    });
    target.addEventListener("pointerleave", () => {
      clearTimeout(hover);
      deferClose();
    });
    target.addEventListener("focusout", deferClose);
  }
}
