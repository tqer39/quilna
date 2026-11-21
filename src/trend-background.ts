import { libraryName } from "./library-context";
import {
  fetchTrendSnapshot,
  trendFreshMs,
  trendSources,
  type TrendSource,
  type TrendSnapshot,
} from "./trend-discovery";
import { readTrendSnapshot, saveTrendSnapshot } from "./trend-store";
import { el } from "./ui";

const preference = libraryName("quilna.trends.background.v1");

export function withTrendLock(
  source: TrendSource,
  signal: AbortSignal,
  work: () => Promise<void>,
) {
  return navigator.locks
    ? navigator.locks.request(
        libraryName("quilna.trends.fetch." + source),
        { signal },
        work,
      )
    : work();
}

/** 辞書を閉じた読書中にも、選んだ情報源だけをライブラリ単位で更新する。 */
export function trendBackgroundControl(
  showSaved: (snapshot: TrendSnapshot) => void,
) {
  const field = el("div", undefined, "rss-trend-background"),
    label = el("label", "読書中に15分ごとに更新する情報源"),
    select = el("select"),
    message = el("p", undefined, "muted");
  label.htmlFor = select.id = "rss-trend-background";
  select.add(new Option("自動更新しない", ""));
  for (const source of trendSources)
    select.add(new Option(source.name, source.id));
  field.append(label, select, message);
  message.setAttribute("aria-live", "polite");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let pageActive = true;
  const selected = () => {
    const value = localStorage.getItem(preference);
    return trendSources.find((s) => s.id === value)?.id;
  };
  function wake() {
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    if (!navigator.locks) {
      select.disabled = true;
      message.textContent = "このブラウザでは手動で更新できます。";
      return;
    }
    try {
      const source = selected();
      select.value = source ?? "";
      message.textContent = "";
      if (!source || !pageActive || document.hidden || !navigator.onLine)
        return;
      const request = new AbortController();
      controller = request;
      void update(source, request);
    } catch {
      message.textContent = "自動更新の設定を確認できません。";
    }
  }
  async function update(source: TrendSource, request: AbortController) {
    let delay = trendFreshMs;
    const timeout = setTimeout(() => request.abort(), 16000);
    try {
      await withTrendLock(source, request.signal, async () => {
        const saved = await readTrendSnapshot(source);
        if (request.signal.aborted || selected() !== source) return;
        if (saved) showSaved(saved);
        const now = Date.now();
        const attemptKey = libraryName("quilna.trends.attempt." + source);
        // 失敗直後のタブ切替・再読み込みでも提供元へ繰り返し送らない。
        const attempts = [
          Number(localStorage.getItem(attemptKey)),
          Date.parse(saved?.fetchedAt ?? ""),
        ];
        const last = Math.max(
          0,
          ...attempts.filter((time) => Number.isFinite(time) && time <= now),
        );
        if (now - last < trendFreshMs) {
          delay = trendFreshMs - (now - last);
          return;
        }
        localStorage.setItem(attemptKey, String(now));
        const snapshot = await fetchTrendSnapshot(source, request.signal);
        if (!request.signal.aborted && selected() === source) {
          const retained = await saveTrendSnapshot(snapshot);
          if (!request.signal.aborted && selected() === source)
            showSaved(retained);
        }
      });
    } catch {
      if (controller === request)
        message.textContent =
          "自動更新を確認できませんでした。保存済みの話題は引き続き読めます。";
    } finally {
      clearTimeout(timeout);
      if (controller === request) {
        controller = undefined;
        timer = setTimeout(wake, delay);
      }
    }
  }
  select.addEventListener("change", () => {
    try {
      if (select.value) localStorage.setItem(preference, select.value);
      else localStorage.removeItem(preference);
      wake();
    } catch {
      wake();
      message.textContent = "自動更新の設定を保存できませんでした。";
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === preference || event.key === null) wake();
  });
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  window.addEventListener("pagehide", () => {
    pageActive = false;
    wake();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      pageActive = true;
      wake();
    }
  });
  wake();
  return field;
}
