import { CollectionNavigation } from "./collection-navigation";
import { documentPolicySettings } from "./document-policy-view";
import {
  FeedAutoRefresh,
  feedLockSupported,
  feedRefreshPreferencesKey,
  nextFeedRefresh,
  readRefreshInterval,
  refreshIntervals,
  withFeedRefreshLock,
} from "./feed-auto-refresh";
import {
  effectiveTags,
  needsTagClassification,
  tagSummary,
} from "./article-tags";
import {
  browserLanguageDetector,
  detectArticleLanguage,
} from "./article-language";
import {
  articleLanguage,
  browserTargetLanguage,
  browserLocale,
  readerLocales,
  speechLocaleFor,
  targetLanguageFor,
  languageName,
  readerLanguages,
  readerPreferencesKey,
  readReaderPreferences,
} from "./reader-preferences";
import { ArticleSearch } from "./article-search";
import { articlePage } from "./article-page";
import { ArticleListView, type ArticleListPosition } from "./article-list-view";
import { ArticleHighlightView } from "./article-highlight-view";
import { ArticleLearningView } from "./article-learning-view";
import { LibraryBackupView } from "./library-backup-view";
import { SourceDocumentView } from "./source-document-view";
import { DocumentAcquisition } from "./document-acquisition";
import { documentAcquisitionSettings } from "./document-acquisition-view";
import {
  retainDocument,
  readDocumentVersion,
  documentSources,
} from "./source-document-store";
import { versionContent, type DocumentVersion } from "./source-document";
import { ArticleConnectionView } from "./article-connection-view";
import { ArticleGraphView } from "./article-graph-view";
import { QuoteConnectionView } from "./quote-connection-view";
import { LearningCueView } from "./learning-cue-view";
import {
  browserTranslator,
  translateArticle,
  isLinkOnly,
} from "./article-content";
import { ArticleSpeech, voiceKey } from "./article-speech";
import { appendArticleText } from "./article-code";
import {
  CloudCollectionClient,
  CloudConnectionError,
  type CloudCollectionState,
} from "./cloud-collection";
import { AuthClient } from "./auth-client";
import { button, el } from "./ui";
import { readerDesignSettings } from "./reader-design";
import "./reader-design.css";
import { parseFeed, type Feed, type FeedArticle } from "./feed-parser";
import { discoverFeeds, sourceURL, type FeedCandidate } from "./feed-discovery";
import {
  openFeedLibrary,
  readFeedLibrary,
  readArticle,
  mergeFeed,
  flagArticle,
  updateArticleContent,
  setArticleTags,
  readFeed,
  recordFeedFailure,
  readSubscriptions,
  setFeedSubscription,
} from "./feed-store";

export async function feedReader(root: HTMLElement) {
  document.title = "情報収集 | Quilna";
  const designSettings = readerDesignSettings();
  function readingJump(label: string, targetId: string) {
    const link = el("a", label, "rss-text-link");
    link.href = `?view=feeds#${targetId}`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = document.getElementById(targetId);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start" });
    });
    return link;
  }
  let db: IDBDatabase | null = null;
  let feeds: Feed[] = [],
    articles: FeedArticle[] = [];
  let selected: string | null = null,
    filter = "all",
    source = "",
    input = "";
  let problem = "",
    retry: (() => void) | null = null,
    connecting = true;
  const searchIndex = new ArticleSearch();
  let searchPreparation: Promise<boolean> | null = null;
  let searchQuery = "",
    searchProblem = "",
    pageNumber = 0;
  let paginationKey = "";
  let tagFilter = "";
  const tagCounts = new Map<string, number>();
  const emptyCounts = { all: 0, unread: 0, saved: 0, pending: 0 };
  // null is the whole library; an empty feed URL is a standalone article.
  const articleCounts = new Map<string | null, typeof emptyCounts>();
  let articlePositions = new Map<string, number>();
  const tagDrafts = new Map<string, string>();
  let tagEditorFor: string | null = null;
  const changingTags = new Set<string>();
  let tagBatchController: AbortController | null = null;
  let tagProgress = "";
  let composing = false;
  let displayedQuery = "";
  const pageSize = 50;
  let epoch = 0;
  const importing = new Set<string>();
  const documentAcquisition = new DocumentAcquisition();
  let addingArticle = false;
  let refreshInterval = readRefreshInterval();
  let collectionProblem = "";
  const cloudClient = new CloudCollectionClient();
  let cloudState: CloudCollectionState | null = null;
  let cloudBusy = false;
  let cloudChecked = false;
  let cloudError = "";
  let cloudRetryCount = 0;
  let cloudTimer: ReturnType<typeof setTimeout> | null = null;
  let discoveredArticleURL = "";
  let translationController: AbortController | null = null;
  let detectionController: AbortController | null = null;
  let translationStatus = "";
  let translatedView = false;
  let originalLanguage = "";
  let preferences = readReaderPreferences();
  let speechRate = 1;
  let readerIdentity: string | null = null;
  const speech = new ArticleSpeech(() => render());
  const documentHistory = new SourceDocumentView(
    async () => {
      const article = articles.find((a) => a.id === selected);
      if (article) await importContent(article, false, false, true);
    },
    chooseDocumentVersion,
    prepareDocument,
  );
  function cancelReading() {
    translationController?.abort();
    translationController = null;
    detectionController?.abort();
    detectionController = null;
    translationStatus = "";
    translatedView = false;
    speech.stop(false);
  }
  window.addEventListener("pagehide", cancelReading);
  window.addEventListener("pagehide", () => tagBatchController?.abort());

  let candidates: FeedCandidate[] = [],
    discoveryNotice = "",
    discovering = false;
  let discoveryEpoch = 0,
    discoveryController: AbortController | null = null;
  const updating = new Set<string>(),
    changing = new Set<string>();
  const feedProblems = new Map<string, string>();
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("tsumiki.rss.v1");
  const rootHeader = el("header", undefined, "rss-header");
  const brand = el("a", "Quilna", "brand");
  brand.href = "/?view=feeds";
  const actions = el("div", undefined, "rss-header-actions");
  const lesson = el("a", "デモ教材を開く", "rss-text-link");
  lesson.href = "/?view=lesson#read";
  const settings = el("dialog", undefined, "rss-settings");
  settings.setAttribute("aria-labelledby", "rss-settings-title");
  const settingsTitle = el("h2", "設定・保存先");
  settingsTitle.id = "rss-settings-title";
  const settingsOpen = button("設定", () => settings.showModal());
  const settingsClose = button("閉じる", () => settings.close());
  settingsClose.className = "rss-settings-close";
  const settingsHeader = el("div", undefined, "rss-settings-header");
  const settingsBody = el("div", undefined, "rss-settings-body");
  settingsHeader.append(settingsTitle, settingsClose);
  settings.append(settingsHeader, settingsBody);
  settingsBody.append(
    designSettings,
    el(
      "p",
      "記事・既読・保存済みの印は、このブラウザ内に保存します。これらの状態は別の端末やブラウザとは同期しません。ブラウザのデータを消去すると失われます。",
    ),
    el(
      "p",
      "RSSの更新には取得サーバーとインターネット接続を使います。取得済みの記事は、配信元が応答しなくても読めます。PC停止中の収集は、下のクラウド設定から開始します。",
    ),
    el(
      "p",
      "記事を開くと選択した取得先から本文を取り込み、このブラウザに保存します。取得できないときは理由と元のRSS情報を表示します。翻訳は対応ブラウザの端末内機能を使い、初回に翻訳データをダウンロードする場合があります。読み上げは端末内の音声を使います。",
    ),
  );
  const backupSettings = new LibraryBackupView(async () => {
    await load();
    render();
  });
  settingsBody.append(backupSettings.root);
  settingsBody.append(documentAcquisitionSettings(documentAcquisition));
  settingsBody.append(documentPolicySettings());
  const targetLabel = el("label", "ロケール（翻訳・読み上げ）");
  targetLabel.htmlFor = "rss-target-language";
  const targetLanguage = el("select");
  targetLanguage.id = targetLabel.htmlFor;
  const browserLanguageOption = el(
    "option",
    browserTargetLanguage()
      ? `ブラウザに合わせる（${browserLocale()}）`
      : "ブラウザに合わせる（対象外の言語）",
  );
  browserLanguageOption.value = "browser";
  targetLanguage.append(browserLanguageOption);
  for (const [code, name] of [...readerLocales, ...readerLanguages]) {
    const option = el("option", name);
    option.value = code;
    targetLanguage.append(option);
  }
  targetLanguage.value = preferences.targetLanguage;
  const autoLabel = el("label", "記事を開いたら自動翻訳");
  autoLabel.htmlFor = "rss-auto-translation";
  const autoTranslation = el("input");
  autoTranslation.type = "checkbox";
  autoTranslation.id = autoLabel.htmlFor;
  autoTranslation.checked = preferences.automatic;
  autoTranslation.disabled = !browserTranslator();
  const preferenceNotice = el(
    "p",
    browserTranslator()
      ? "既定はブラウザの言語・地域です。選んだ言語へ翻訳し、表示中の本文の言語に合う端末内音声で読み上げます。自動翻訳は最初はオフです。設定はこのブラウザに保存します。"
      : "このブラウザは端末内翻訳に対応していません。外部サービスには送信していません。",
    "muted",
  );
  preferenceNotice.setAttribute("role", "status");
  function updatePreferences() {
    cancelReading();
    preferences = {
      targetLanguage: targetLanguage.value,
      automatic: autoTranslation.checked,
    };
    try {
      localStorage.setItem(readerPreferencesKey, JSON.stringify(preferences));
      preferenceNotice.textContent = "ロケールと翻訳設定を保存しました。";
    } catch {
      preferenceNotice.textContent =
        "設定を保存できませんでした。今回は適用しますが、次回は設定し直してください。";
    }
    render();
    autoTranslateSelected();
  }
  targetLanguage.addEventListener("change", updatePreferences);
  autoTranslation.addEventListener("change", updatePreferences);
  const translationSettings = el(
    "section",
    undefined,
    "rss-translation-settings",
  );
  translationSettings.append(
    el("h3", "言語・地域と読み上げ"),
    targetLabel,
    targetLanguage,
    el(
      "p",
      "翻訳は選んだ言語で行い、地域は読み上げ音声の選択に使います。原文を表示している場合は原文の言語で読み上げます。",
      "muted",
    ),
    autoTranslation,
    autoLabel,
    preferenceNotice,
  );
  settingsBody.insertBefore(translationSettings, designSettings.nextSibling);
  window.addEventListener("languagechange", () => {
    browserLanguageOption.textContent = browserTargetLanguage()
      ? `ブラウザに合わせる（${browserLocale()}）`
      : "ブラウザに合わせる（対象外の言語）";
    if (preferences.targetLanguage !== "browser") return;
    cancelReading();
    render();
    autoTranslateSelected();
  });
  const refreshSettings = el("section", undefined, "rss-translation-settings");
  const refreshLabel = el("label", "RSSの自動更新");
  refreshLabel.htmlFor = "rss-refresh-interval";
  const refreshSelect = el("select");
  refreshSelect.id = refreshLabel.htmlFor;
  for (const minutes of refreshIntervals) {
    const option = el("option", minutes ? `${minutes}分ごと` : "オフ");
    option.value = String(minutes);
    refreshSelect.append(option);
  }
  refreshSelect.value = String(refreshInterval);
  refreshSelect.disabled = !feedLockSupported();
  const refreshNotice = el(
    "p",
    "この設定は画面表示中の更新に適用します。非表示・オフライン中は待機します。クラウド収集を開始すると、下のクラウド設定を優先します。",
    "muted",
  );
  refreshNotice.setAttribute("role", "status");
  refreshSelect.addEventListener("change", () => {
    refreshInterval = Number(refreshSelect.value);
    collectionProblem = "";
    try {
      localStorage.setItem(
        feedRefreshPreferencesKey,
        JSON.stringify(refreshInterval),
      );
      refreshNotice.textContent =
        "画面表示中の更新設定を保存しました。クラウド収集の設定は別です。";
    } catch {
      refreshNotice.textContent =
        "設定を保存できませんでした。今回は適用しますが、次回は設定し直してください。";
    }
    render();
    collector.wake();
  });
  refreshSettings.append(
    el("h3", "情報の収集"),
    refreshLabel,
    refreshSelect,
    refreshNotice,
  );
  settingsBody.insertBefore(refreshSettings, translationSettings);
  settings.addEventListener("close", () => settingsOpen.focus());
  const skipToArticles = readingJump("記事へ", "rss-main");
  skipToArticles.classList.add("rss-skip-navigation");
  const demo = el("section");
  demo.setAttribute("aria-label", "デモ教材");
  demo.append(
    el("h3", "デモ教材"),
    el(
      "p",
      "CAAを題材にした固定のデモ教材です。収集した記事から作られた教材ではありません。以前の学習記録も引き続き利用できます。",
    ),
    lesson,
  );
  settingsBody.append(demo);
  actions.append(skipToArticles, settingsOpen);
  rootHeader.append(brand, actions);
  const layout = el("div", undefined, "rss-shell");
  const navigation = el("section", undefined, "rss-navigation");
  navigation.setAttribute("aria-label", "収集メニュー");
  const collectionNavigation = new CollectionNavigation(navigation, {
    filter: (value) => {
      filter = value;
      selected = null;
      render();
    },
    input: (value) => {
      input = value;
      clearDiscovery();
    },
    discover: (value) => void discover(value),
    add: (value) => void addArticle(value),
    source: (value) => {
      source = value;
      selected = null;
      render();
    },
    refresh: (url, insert) => void refresh(url, insert),
    refreshAll: () => void refreshAll(),
    subscription: (url, subscribed) => void changeSubscription(url, subscribed),
  });
  const main = el("main", undefined, "rss-main");
  main.id = "rss-main";
  main.tabIndex = -1;
  // Keep list controls connected while background writes refresh the results.
  const listHeading = el("h1");
  listHeading.tabIndex = -1;
  const listLede = el(
    "p",
    "記事のタイトルを押すと本文を読めます。あとで読みたい記事は保存しておきましょう。",
    "rss-lede",
  );
  const highlights = new ArticleHighlightView(
    (quote) => quoteConnections.begin(quote),
    (quote) => learningRecords.begin(quote),
  );
  const learningRecords = new ArticleLearningView((quote, signal) =>
    highlights.revealSaved(quote, signal),
  );
  const quoteConnections = new QuoteConnectionView(
    () => articles,
    (quote) => graph.showQuote(quote),
  );
  const learning = new LearningCueView(
    (view, cue) => highlights.revealExcerpt(view, cue.start, cue.end),
    (view, cue) =>
      highlights.prepareExcerpt(
        view,
        cue.start,
        cue.end,
        `問い：${cue.prompt}`,
      ),
  );
  let relationLibraryRevision = 0;
  const connections = new ArticleConnectionView(
    () => articles,
    (id) => {
      const position = articlePositions.get(id);
      return position === undefined ? undefined : articles[position];
    },
    (id) => {
      const position = articlePositions.get(id);
      if (position !== undefined) openArticle(articles[position]);
    },
  );
  const graph = new ArticleGraphView(
    () => articles,
    (id) => {
      const position = articlePositions.get(id);
      return position === undefined ? undefined : articles[position];
    },
    (id) => {
      const position = articlePositions.get(id);
      if (position !== undefined) openArticle(articles[position]);
    },
    (quote, signal) => highlights.revealSaved(quote, signal),
    (quote) => quoteConnections.begin(quote),
  );
  let listPosition: ArticleListPosition | null = null;
  const readerNavigation = el("nav", undefined, "rss-reader-navigation");
  readerNavigation.setAttribute("aria-label", "記事の移動");
  const returnToList = button("← 記事一覧へ", () => {
    selected = null;
    render();
    if (!listPosition || !listView.restorePosition(listPosition)) {
      listHeading.focus({ preventScroll: true });
      main.scrollIntoView({ block: "start" });
    }
    listPosition = null;
  });
  returnToList.id = "rss-return-to-list";
  readerNavigation.append(returnToList);
  const listView = new ArticleListView({
    open: (id) => {
      const position = articlePositions.get(id);
      if (position !== undefined) {
        listPosition = listView.position(id);
        openArticle(articles[position]);
      }
    },
    classify: () => void classifyPending(),
    cancel: () => tagBatchController?.abort(),
    retry: () =>
      void load().catch((error) =>
        showError((error as Error).message, () => void connect()),
      ),
    clear: () => {
      searchQuery = displayedQuery = "";
      render();
    },
    page: (delta) => {
      pageNumber += delta;
      render();
    },
  });
  const listResults = listView.root;
  const searchLabel = el("label", "保存領域の記事を検索");
  searchLabel.htmlFor = "rss-search";
  const searchField = el("input");
  searchField.id = "rss-search";
  searchField.type = "search";
  searchField.maxLength = 300;
  searchField.placeholder = "題名・本文・保存した翻訳・タグ";
  searchField.addEventListener("compositionstart", () => {
    composing = true;
  });
  const updateQuery = () => {
    searchQuery = searchField.value;
    if (!composing) {
      displayedQuery = searchQuery;
      pageNumber = 0;
      render();
    }
  };
  searchField.addEventListener("compositionend", () => {
    composing = false;
    updateQuery();
  });
  searchField.addEventListener("input", updateQuery);
  const tagFilterLabel = el("label", "タグで絞り込み");
  tagFilterLabel.htmlFor = "rss-tag-filter";
  const tagsSelect = el("select");
  tagsSelect.id = tagFilterLabel.htmlFor;
  tagsSelect.addEventListener("change", () => {
    tagFilter = tagsSelect.value;
    pageNumber = 0;
    render();
  });
  const discoveryPanel = el("section", undefined, "rss-discovery");
  discoveryPanel.setAttribute("aria-label", "見つかった配信元");
  const errors = el("div", undefined, "rss-error");
  errors.setAttribute("role", "alert");
  errors.hidden = true;
  layout.append(navigation, main);
  root.append(rootHeader, layout, errors, settings);

  function canCollect() {
    return (
      !!db &&
      !connecting &&
      !collectionProblem &&
      refreshInterval > 0 &&
      cloudChecked &&
      !(cloudState?.available && cloudState.interval > 0) &&
      feedLockSupported() &&
      navigator.onLine &&
      !document.hidden
    );
  }
  const collector = new FeedAutoRefresh({
    feeds: () => feeds,
    interval: () => refreshInterval,
    canRun: canCollect,
    refresh: (address) => refresh(address, false, true),
    failed: () => {
      collectionProblem =
        "自動更新を停止しました。保存領域を確認し、設定で自動更新を選び直してください。";
      render();
    },
  });
  const cloudSection = el("section", undefined, "rss-translation-settings");
  const cloudNotice = el("p", "クラウド収集の接続を確認しています。", "muted");
  cloudNotice.setAttribute("role", "status");
  cloudNotice.id = "rss-cloud-status";
  const cloudInterval = el("select");
  let cloudIntervalDirty = false;
  cloudInterval.addEventListener("change", () => {
    cloudIntervalDirty = true;
  });
  cloudInterval.id = "rss-cloud-interval";
  const cloudLabel = el("label", "クラウドの収集間隔");
  cloudLabel.htmlFor = cloudInterval.id;
  for (const minutes of [15, 30, 60]) {
    const option = el("option", `${minutes}分ごと`);
    option.value = String(minutes);
    cloudInterval.append(option);
  }
  const cloudStart = button(
    "クラウド収集を開始・設定を更新",
    () => void configureCloud(false),
  );
  const cloudStop = button(
    "クラウド収集を停止",
    () => void configureCloud(true),
  );
  const cloudCheck = button(
    "クラウドの状態確認・記事を取り込む",
    () => void checkCloud(),
  );
  const cloudFailures = el("div");
  cloudFailures.id = "rss-cloud-failures";
  const cloudRetry = button("取り込めない取得結果を再試行", () => {
    if (cloudBusy) return;
    cloudClient.retryFailures();
    void checkCloud();
  });
  const cloudLogin = button("クラウド収集にログイン", async () => {
    const auth = new AuthClient();
    const status = await auth.status();
    const url = status.available ? await auth.start() : null;
    if (url) location.assign(url);
    else {
      cloudError =
        "ログインに接続できませんでした。クラウドの接続準備を確認してください。";
      renderCloud();
    }
  });
  cloudLogin.hidden = true;
  cloudSection.append(
    el("h3", "PCを閉じている間の収集"),
    el(
      "p",
      "クラウドに購読先と取得したRSS本文を保存し、PCのスリープ・電源オフ中も収集します。ここで開始した収集は、ログアウトしても「停止」を選ぶまで続きます。既読・保存済みの印や取り込んだ記事の原文は、このブラウザに保持します。",
    ),
    cloudLabel,
    cloudInterval,
    cloudStart,
    cloudStop,
    cloudCheck,
    cloudLogin,
    cloudNotice,
    cloudFailures,
    cloudRetry,
  );
  settingsBody.insertBefore(cloudSection, translationSettings);
  function renderCloud() {
    const failures = cloudState ? cloudClient.failures(cloudState) : [];
    cloudRetry.hidden = !failures.length;
    cloudRetry.disabled = cloudBusy;
    cloudFailures.replaceChildren();
    for (const item of failures) {
      const entry = el("section");
      const remove = button(
        "この取得結果を削除",
        () => void discardCloud(item.id),
      );
      remove.disabled = cloudBusy || !cloudState?.available;
      entry.append(
        el(
          "p",
          `${item.feedUrl}（${new Date(item.fetchedAt).toLocaleString()}）：${item.reason} クラウドに保持しています。他の取得結果の取り込みは続けます。`,
        ),
        remove,
      );
      cloudFailures.append(entry);
    }
    cloudStart.disabled =
      cloudBusy || !cloudState?.available || !db || !feeds.length;
    cloudStop.disabled =
      cloudBusy || !cloudState?.available || !cloudState.interval;
    cloudCheck.disabled = cloudBusy || !db;
    cloudInterval.disabled = cloudBusy;
    cloudLogin.hidden = !cloudError.includes("ログインが必要");
    cloudNotice.textContent = cloudBusy
      ? "クラウドの処理中です…"
      : (cloudError &&
          `${cloudError}${cloudRetryCount ? " 接続の回復を待って自動的に再確認します。" : ""}`) ||
        (!cloudState?.available
          ? "クラウド収集はまだ利用できません。現在は画面表示中の更新のみです。"
          : `${cloudState.interval ? `クラウドで${cloudState.interval}分ごとに収集を設定済み` : "クラウド収集は停止中"}。未取り込みの取得結果：${cloudState.pending.length}件。${failures.length ? `取り込めない取得結果：${failures.length}件。下の理由を確認してください。` : ""}${cloudState.blocked ? "保存上限に達したため収集を一時停止しています。取得済みの記事を取り込んでください。" : ""}${cloudState.feeds.some((feed) => feed.error) ? "取得に失敗した配信元があります。再試行を待っています。" : ""} ${cloudState.sourcePolicy === "public-https" ? "公開HTTPSのサイト・RSSに対応します。ログインが必要なページや配信元側の制限により取得できない場合があります。" : `対応する配信元：${cloudState.hosts.join("、")}。`}追加した購読先は「設定を更新」でクラウドに反映できます。`);
  }
  function acceptCloudState(next: CloudCollectionState) {
    if (cloudState?.account !== next.account) cloudIntervalDirty = false;
    cloudState = next;
    if (!cloudIntervalDirty && next.interval)
      cloudInterval.value = String(next.interval);
  }
  function scheduleCloud() {
    if (cloudTimer) clearTimeout(cloudTimer);
    cloudTimer = null;
    if (
      !document.hidden &&
      navigator.onLine &&
      ((cloudState?.available && !cloudError) || cloudRetryCount > 0)
    )
      cloudTimer = setTimeout(
        () => void checkCloud(),
        cloudRetryCount
          ? Math.min(300000, 30000 * 2 ** (cloudRetryCount - 1))
          : cloudState &&
              cloudState.pending.length >
                cloudClient.failures(cloudState).length
            ? 15000
            : 60000,
      );
  }
  async function checkCloud() {
    if (!db || cloudBusy || document.hidden || !navigator.onLine) return;
    cloudBusy = true;
    renderCloud();
    try {
      const latest = await cloudClient.status();
      acceptCloudState(latest);
      if (latest.available && latest.pending.length) {
        try {
          await cloudClient.importPending(db, latest);
        } finally {
          // Earlier documents may already be committed when a later save/ACK fails.
          await load();
          announceChange();
        }
        acceptCloudState(await cloudClient.status());
      }
      cloudError = "";
      cloudRetryCount = 0;
    } catch (error) {
      cloudError = cloudFailure(error);
      cloudRetryCount =
        error instanceof CloudConnectionError
          ? Math.min(5, cloudRetryCount + 1)
          : 0;
    } finally {
      cloudBusy = false;
      cloudChecked = true;
      renderCloud();
      render();
      scheduleCloud();
      collector.wake();
    }
  }
  function cloudFailure(error: unknown) {
    if (error instanceof Error && error.name === "AbortError")
      return "クラウドの応答が時間内に届きませんでした。取得済みの記事は保持しています。";
    if (
      error instanceof Error &&
      !["ZodError", "SyntaxError", "TypeError"].includes(error.name)
    )
      return error.message;
    return "クラウドの応答を確認できませんでした。取得済みの記事は保持しています。";
  }
  async function discardCloud(id: string) {
    if (!cloudState || cloudBusy) return;
    const item = cloudClient
      .failures(cloudState)
      .find((item) => item.id === id);
    if (
      !item ||
      !window.confirm(
        `${item.feedUrl} の ${new Date(item.fetchedAt).toLocaleString()} の取得結果をクラウドから削除します。未取り込みの内容は失われ、元に戻せません。このブラウザの記事や購読設定は残ります。削除しますか？`,
      )
    )
      return;
    cloudBusy = true;
    renderCloud();
    try {
      acceptCloudState(await cloudClient.discard(cloudState, id));
      cloudError = "";
      cloudRetryCount = 0;
    } catch (error) {
      cloudError = cloudFailure(error);
      cloudRetryCount =
        error instanceof CloudConnectionError
          ? Math.min(5, cloudRetryCount + 1)
          : 0;
    } finally {
      cloudBusy = false;
      renderCloud();
      render();
      scheduleCloud();
      collector.wake();
    }
  }
  async function configureCloud(stop: boolean) {
    if (!cloudState || cloudBusy) return;
    cloudBusy = true;
    renderCloud();
    try {
      const currentState = cloudState;
      const localFeeds = stop ? [] : await readSubscriptions(db!);
      const removed = new Set(
        localFeeds.filter((feed) => feed.unsubscribed).map((feed) => feed.url),
      );
      const urls = stop
        ? currentState.feeds.map((feed) => feed.url)
        : [
            ...new Set([
              ...currentState.feeds.map((feed) => feed.url),
              ...localFeeds.map((feed) => feed.url),
            ]),
          ].filter((url) => !removed.has(url));
      const next = await cloudClient.configure(
        currentState,
        urls,
        stop ? 0 : (Number(cloudInterval.value) as 15 | 30 | 60),
      );
      cloudIntervalDirty = false;
      acceptCloudState(next);
      if (!stop) {
        for (const feed of localFeeds) {
          if (
            feed.unsubscribed &&
            feed.cloudUnsubscribePending &&
            feed.subscriptionRevision !== undefined
          )
            await setFeedSubscription(
              db!,
              feed.url,
              false,
              feed.subscriptionRevision,
            );
        }
        await load();
        announceChange();
      }
      cloudError = "";
      cloudRetryCount = 0;
    } catch (error) {
      cloudError = cloudFailure(error);
      cloudRetryCount =
        error instanceof CloudConnectionError
          ? Math.min(5, cloudRetryCount + 1)
          : 0;
    } finally {
      cloudBusy = false;
      renderCloud();
      render();
      scheduleCloud();
      collector.wake();
    }
  }
  async function changeSubscription(address: string, subscribed: boolean) {
    if (!db || cloudBusy || updating.has(address)) return;
    const feed = feeds.find((item) => item.url === address);
    if (
      !feed ||
      !window.confirm(
        subscribed
          ? `${feed.title} の購読を再開します。クラウド収集も再開する場合は、設定の「クラウド収集を開始・設定を更新」を押してください。再開しますか？`
          : `${feed.title} の購読を解除します。保存済みの記事・本文・メモはすべて残ります。クラウド収集の解除も確認します。解除しますか？`,
      )
    )
      return;
    const expectedAccount = cloudState?.account;
    updating.add(address);
    cloudBusy = true;
    renderCloud();
    render();
    try {
      const ran = await withFeedRefreshLock(address, async () => {
        const revision = await setFeedSubscription(db!, address, subscribed);
        await load();
        announceChange();
        if (subscribed) return;
        // Local collection stops before any network work. A failed or lost
        // response leaves a persisted pending marker, never a false success.
        const latest = await cloudClient.status();
        if (expectedAccount && latest.account !== expectedAccount)
          throw Error(
            "ログイン中のアカウントが変わりました。クラウドの解除を確認できません。画面を再読み込みしてください。",
          );
        if (!latest.available)
          throw Error("クラウド収集を利用できないため、解除を確認できません。");
        const next = latest.feeds.some((f) => f.url === address)
          ? await cloudClient.configure(
              latest,
              latest.feeds.filter((f) => f.url !== address).map((f) => f.url),
              latest.interval,
            )
          : latest;
        acceptCloudState(next);
        if (revision !== null)
          await setFeedSubscription(db!, address, false, revision);
        await load();
        announceChange();
      });
      if (!ran)
        throw Error(
          "この配信元をほかの画面で更新中です。少し待ってから購読操作を再試行してください。",
        );
      problem = "";
    } catch (error) {
      const current = await readFeed(db!, address).catch(() => undefined);
      showError(
        `${
          current?.unsubscribed
            ? current.cloudUnsubscribePending
              ? "このブラウザの購読は解除済みです。クラウドの解除は未確認です。"
              : "このブラウザの購読は解除したままです。"
            : "購読の変更を完了できませんでした。"
        } ${cloudFailure(error)}`,
        () => void changeSubscription(address, subscribed),
      );
    } finally {
      updating.delete(address);
      cloudBusy = false;
      renderCloud();
      render();
      scheduleCloud();
      collector.wake();
    }
  }
  const collectionWake = () => {
    render();
    collector.wake();
    if (document.hidden || !navigator.onLine) {
      if (cloudTimer) clearTimeout(cloudTimer);
      cloudTimer = null;
    } else if (!cloudChecked || cloudState?.available) void checkCloud();
  };
  document.addEventListener("visibilitychange", collectionWake);
  window.addEventListener("online", collectionWake);
  window.addEventListener("offline", collectionWake);
  window.addEventListener("pagehide", () => collector.stop());
  window.addEventListener("pagehide", () => {
    if (cloudTimer) clearTimeout(cloudTimer);
  });
  window.addEventListener("pageshow", () => collector.start());
  window.addEventListener("storage", (event) => {
    if (event.key !== feedRefreshPreferencesKey && event.key !== null) return;
    refreshInterval = readRefreshInterval();
    refreshSelect.value = String(refreshInterval);
    collectionProblem = "";
    collectionWake();
  });
  function showError(message: string, action: () => void) {
    problem = message;
    retry = action;
    renderError();
  }
  function renderError() {
    errors.replaceChildren();
    errors.hidden = !problem;
    if (problem)
      errors.append(
        el("strong", problem),
        button("再試行", () => {
          problem = "";
          renderError();
          retry?.();
        }),
      );
  }
  const articleLoads = new Map<string, number>();
  function countArticleMetadata(article: FeedArticle, direction: 1 | -1) {
    for (const key of [null, article.feedUrl]) {
      const counts = articleCounts.get(key) ?? { ...emptyCounts };
      counts.all += direction;
      if (!article.read) counts.unread += direction;
      if (article.saved) counts.saved += direction;
      if (needsTagClassification(article)) counts.pending += direction;
      if (counts.all) articleCounts.set(key, counts);
      else articleCounts.delete(key);
    }
    for (const tag of effectiveTags(article)) {
      const count = (tagCounts.get(tag) ?? 0) + direction;
      if (count > 0) tagCounts.set(tag, count);
      else tagCounts.delete(tag);
    }
  }
  async function load(id?: string) {
    if (!db) return;
    if (id && searchIndex.ready) {
      const version = (articleLoads.get(id) ?? 0) + 1;
      articleLoads.set(id, version);
      const libraryVersion = epoch;
      const article = await readArticle(db, id);
      if (articleLoads.get(id) !== version) return;
      if (libraryVersion !== epoch || !searchIndex.ready) return load();
      const index = articlePositions.get(id) ?? -1;
      if (index < 0) return load();
      const old = articles[index];
      if (
        old.published !== article.published ||
        old.fetchedAt !== article.fetchedAt
      )
        return load();
      countArticleMetadata(old, -1);
      articles[index] = article;
      countArticleMetadata(article, 1);
      searchIndex.update(article);
      relationLibraryRevision++;
      return;
    }
    searchIndex.invalidate();
    const ticket = ++epoch;
    const loaded = await readFeedLibrary(db);
    if (ticket !== epoch) return;
    feeds = loaded.feeds;
    for (const feed of feeds)
      if (!feed.refreshFailure) feedProblems.delete(feed.url);
    articles = loaded.articles.sort(
      (a, b) =>
        (b.published ?? b.fetchedAt).localeCompare(
          a.published ?? a.fetchedAt,
        ) || a.id.localeCompare(b.id),
    );
    articlePositions = new Map(
      articles.map((article, index) => [article.id, index]),
    );
    relationLibraryRevision++;
    tagCounts.clear();
    articleCounts.clear();
    for (const article of articles) countArticleMetadata(article, 1);
    searchProblem = "";
    searchPreparation = searchIndex.prepare(articles);
    void searchPreparation
      .then((current) => {
        if (current) render();
      })
      .catch(() => {
        if (ticket === epoch) {
          searchProblem = "検索を準備できませんでした。記事は保持しています。";
          render();
        }
      });
  }
  function announceChange(id?: string) {
    channel?.postMessage(id ? { articleId: id } : "changed");
  }
  async function connect() {
    connecting = true;
    render();
    try {
      db?.close();
      db = await openFeedLibrary();
      await load();
      problem = "";
    } catch (error) {
      showError((error as Error).message, () => void connect());
    } finally {
      connecting = false;
      render();
    }
  }
  function clearDiscovery() {
    discoveryEpoch++;
    discoveryController?.abort();
    discoveryController = null;
    discovering = false;
    candidates = [];
    discoveryNotice = "";
    discoveredArticleURL = "";
    renderDiscovery();
  }
  async function requestSource(
    address: string,
    signal: AbortSignal,
    discover = false,
  ) {
    const response = await fetch("/api/feeds/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: address,
        ...(discover ? { discover: true } : {}),
      }),
      signal,
    });
    if (!response.ok)
      throw Error(
        response.status === 404
          ? "この環境には取得サーバーがありません。ローカル起動を確認してください。"
          : "取得できませんでした。公開HTTPSのURLか、通信状態を確認してください。",
      );
    const result = await response.json();
    if (
      typeof result?.url !== "string" ||
      (typeof result?.xml !== "string" && typeof result?.html !== "string")
    )
      throw Error("取得サーバーの応答を確認してください。");
    sourceURL(result.url);
    return result as { url: string; xml?: string; html?: string };
  }
  async function discover(value: string) {
    clearDiscovery();
    let address: string;
    try {
      address = sourceURL(value);
      discoveredArticleURL = address;
    } catch {
      discoveryNotice =
        "サイト・記事・RSSのURLを入力してください。公開HTTPSのサイトに対応しています。";
      render();
      return;
    }
    if (!db) return;
    const ticket = discoveryEpoch;
    const controller = new AbortController();
    discoveryController = controller;
    discovering = true;
    render();
    const timeout = setTimeout(() => controller.abort(), 16000);
    try {
      let result = await requestSource(address, controller.signal, true);
      const find = (result: {
        url: string;
        xml?: string;
        html?: string;
      }): FeedCandidate[] => {
        if (typeof result.xml === "string") {
          const parsed = parseFeed(result.xml, result.url, result.url);
          return [
            {
              url: result.url,
              title: parsed.feed.title,
              format: `${parsed.articles.length}件の記事`,
            },
          ];
        }
        return discoverFeeds(result.html!, result.url);
      };
      let found = find(result);
      const home = new URL(result.url).origin + "/";
      if (!found.length && result.url !== home) {
        result = await requestSource(home, controller.signal, true);
        found = find(result);
      }
      if (ticket === discoveryEpoch) {
        candidates = found;
        discoveryNotice = found.length
          ? "登録する配信元を選んでください。"
          : "配信元が見つかりませんでした。サイトでRSSが公開されていない場合があります。単独の記事として取り込むか、トップページやRSSのURLで試してください。";
      }
    } catch (error) {
      if (ticket === discoveryEpoch)
        discoveryNotice = controller.signal.aborted
          ? "時間内に見つけられませんでした。URLや通信状態を確認して、もう一度探してください。保存した記事は引き続き読めます。"
          : (error as Error).message;
    } finally {
      clearTimeout(timeout);
      if (ticket === discoveryEpoch) {
        discovering = false;
        discoveryController = null;
        const focusSearch =
          document.activeElement === document.body ||
          ["feed-url", "rss-find-feeds"].includes(
            document.activeElement?.id ?? "",
          );
        render();
        if (focusSearch) {
          discoveryPanel.querySelector<HTMLElement>("h2")?.focus();
          discoveryPanel.scrollIntoView({ block: "start" });
        }
      }
    }
  }
  function renderDiscovery() {
    discoveryPanel.replaceChildren();
    discoveryPanel.hidden =
      !discovering && !candidates.length && !discoveryNotice;
    const heading = el(
      "h2",
      discovering ? "配信元を探しています…" : "配信元を追加",
    );
    heading.tabIndex = -1;
    const notice = el(
      "p",
      discovering
        ? "サイトを確認しています。取得済みの記事はそのまま読めます。"
        : discoveryNotice,
    );
    notice.setAttribute("role", "status");
    discoveryPanel.append(heading, notice);
    const list = el("ul", undefined, "rss-candidates");
    for (const candidate of candidates) {
      const item = el("li");
      const existing = feeds.find((feed) => feed.url === candidate.url);
      const registered = existing && !existing.unsubscribed;
      const add = button(
        registered
          ? "登録済みの配信元を読む"
          : existing?.unsubscribed
            ? "購読を再開"
            : "登録して読む",
        () => {
          if (registered) {
            source = candidate.url;
            filter = "all";
            selected = null;
            clearDiscovery();
            render();
          } else if (existing?.unsubscribed)
            void changeSubscription(candidate.url, true);
          else void refresh(candidate.url, true);
        },
      );
      add.disabled = !db || updating.has(candidate.url);
      item.append(
        el("h3", candidate.title),
        el("p", `${candidate.format} · ${candidate.url}`, "muted"),
        add,
      );
      list.append(item);
    }
    if (!discovering && !candidates.length && discoveredArticleURL) {
      const collect = button(
        "この記事を取り込んで保存",
        () => void addArticle(discoveredArticleURL),
      );
      collect.disabled = addingArticle || !db;
      discoveryPanel.append(collect);
    }
    discoveryPanel.append(
      list,
      button("閉じる", () => {
        clearDiscovery();
        render();
      }),
    );
  }
  async function refresh(
    value: string,
    registering = false,
    automatic = false,
  ) {
    const registrationTicket = discoveryEpoch;
    let url: URL;
    try {
      url = new URL(value.trim());
      if (url.protocol !== "https:" || url.username || url.password || url.port)
        throw Error();
      url.hash = "";
    } catch {
      showError(
        "公開HTTPSの配信元URLを選んでください。",
        () => void refresh(input, registering),
      );
      return;
    }
    const address = url.href;
    if (!db || updating.has(address)) return;
    if (
      registering &&
      feeds.length >= 50 &&
      !feeds.some((f) => f.url === address)
    ) {
      showError(
        "この試作では50件まで登録できます。",
        () => void refresh(address, true),
      );
      return;
    }
    updating.add(address);
    feedProblems.delete(address);
    render();
    try {
      const ran = await withFeedRefreshLock(address, async () => {
        const current = await readFeed(db!, address);
        if (current?.unsubscribed) return;
        if (automatic) {
          if (!canCollect()) return;
          if (
            !current ||
            nextFeedRefresh(current, refreshInterval) > Date.now()
          )
            return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 16000);
        try {
          const result = await requestSource(address, controller.signal);
          if (typeof result.xml !== "string")
            throw Error("RSS取得サーバーの応答を確認してください。");
          const parsed = parseFeed(result.xml, address, result.url);
          await mergeFeed(db!, parsed.feed, parsed.articles);
          await load();
          announceChange();
          problem = "";
          if (registering) {
            if (registrationTicket === discoveryEpoch) {
              clearDiscovery();
              input = "";
            }
            source = address;
            filter = "all";
            selected = null;
          }
        } catch (error) {
          const message = controller.signal.aborted
            ? "更新が時間内に終わりませんでした。保存した記事は引き続き読めます。"
            : (error as Error).message;
          feedProblems.set(address, message);
          if (registering)
            showError(message, () => void refresh(address, true));
          else {
            try {
              await recordFeedFailure(db!, address, message);
              await load();
              announceChange();
            } catch {
              collectionProblem =
                "更新の待機時刻を保存できないため自動更新を停止しました。保存領域を確認し、設定で自動更新を選び直してください。";
            }
          }
        } finally {
          clearTimeout(timeout);
        }
      });
      if (!ran && !automatic) {
        const message =
          "ほかの更新が進行中です。少し待ってから再試行してください。";
        feedProblems.set(address, message);
        if (registering) showError(message, () => void refresh(address, true));
      }
    } catch (error) {
      feedProblems.set(address, (error as Error).message);
      if (registering)
        showError((error as Error).message, () => void refresh(address, true));
      if (automatic)
        collectionProblem =
          "自動更新を開始できませんでした。設定で自動更新を選び直すか、手動で更新してください。";
    } finally {
      updating.delete(address);
      render();
    }
  }

  async function refreshAll() {
    const queue = feeds
      .filter((f) => !f.unsubscribed)
      .map((f) => f.url)
      .filter((url) => !updating.has(url));
    await Promise.all(
      [0, 1].map(async () => {
        while (queue.length) await refresh(queue.shift()!);
      }),
    );
  }
  async function change(
    article: FeedArticle,
    field: "saved" | "read",
    value: boolean,
  ) {
    if (!db || changing.has(article.id)) return;
    changing.add(article.id);
    render();
    try {
      await flagArticle(db, article.id, field, value);
      await load(article.id);
      announceChange(article.id);
      problem = "";
    } catch (error) {
      showError(
        (error as Error).message,
        () => void change(article, field, value),
      );
    } finally {
      changing.delete(article.id);
      render();
    }
  }
  async function importContent(
    article: FeedArticle,
    insert = false,
    restoreCode = false,
    refreshOriginal = false,
  ) {
    if (!db || importing.has(article.id)) return;
    if (selected === article.id) cancelReading();
    importing.add(article.id);
    render();
    try {
      const acquisition = documentAcquisition.snapshot();
      let patch;
      try {
        const seed =
          article.content ??
          articles.find((a) => a.url === article.url && a.content)?.content;
        if (seed && !seed.document)
          await retainDocument(article.url, seed, { seed: true });
        const acquired = await documentAcquisition.acquire(
          article.url,
          restoreCode || refreshOriginal,
          acquisition,
        );
        patch =
          (refreshOriginal || restoreCode) && acquired.warning
            ? { contentError: acquired.warning }
            : { content: acquired.content, contentError: acquired.warning };
      } catch (error) {
        patch = { contentError: (error as Error).message };
      }
      acquisition.check();
      await updateArticleContent(
        db,
        article,
        patch,
        insert,
        acquisition.signal,
        restoreCode,
        refreshOriginal ? "replace" : "preserve",
      );
      await load(article.id);
      announceChange(article.id);
      problem = "";
      if (selected === article.id && patch.content) {
        // A faster tab may have saved a different original. Use the persisted
        // snapshot, not the language of a response that the store discarded.
        const saved = articles.find((entry) => entry.id === article.id);
        originalLanguage = articleLanguage(saved?.content?.language);
        speech.stop(false);
      }
    } catch (error) {
      showError(
        (error as Error).message,
        () => void importContent(article, insert, restoreCode, refreshOriginal),
      );
    } finally {
      importing.delete(article.id);
      render();
      if (selected === article.id) autoTranslateSelected();
    }
  }
  async function prepareDocument() {
    const article = articles.find((a) => a.id === selected);
    if (
      !db ||
      !article?.content ||
      article.content.document ||
      importing.has(article.id)
    )
      return;
    importing.add(article.id);
    render();
    try {
      const retained = await retainDocument(article.url, article.content, {
        seed: true,
      });
      await updateArticleContent(
        db,
        article,
        {
          content: {
            ...article.content,
            document: versionContent(retained.version).document,
          },
        },
        false,
        undefined,
        false,
        "metadata",
      );
      await load(article.id);
      announceChange(article.id);
    } finally {
      importing.delete(article.id);
      render();
    }
  }
  async function chooseDocumentVersion(version: DocumentVersion) {
    const article = articles.find((a) => a.id === selected);
    if (!db || !article?.content?.document || importing.has(article.id)) return;
    importing.add(article.id);
    cancelReading();
    render();
    try {
      const sources = await documentSources(article.url);
      if (
        !sources.some(
          (source) =>
            source.id === version.documentId &&
            source.scope === version.scope &&
            source.sourceURL === version.sourceURL,
        )
      )
        throw Error("この記事の本文の保存履歴を確認できません。");
      const stored = await readDocumentVersion(
        version.documentId,
        version.id,
        version.scope,
      );
      await updateArticleContent(
        db,
        article,
        { content: versionContent(stored) },
        false,
        undefined,
        false,
        "replace",
      );
      await load(article.id);
      announceChange(article.id);
      if (selected === article.id)
        originalLanguage = articleLanguage(stored.content.language);
    } finally {
      importing.delete(article.id);
      render();
    }
  }
  async function addArticle(value: string) {
    if (!db || addingArticle) return;
    let url: string;
    try {
      url = sourceURL(value);
    } catch {
      showError(
        "公開HTTPSの記事URLを入力してください。",
        () => void addArticle(value),
      );
      return;
    }
    listPosition = null;
    const old = articles.find((a) => a.url === url);
    if (old) {
      if (!old.saved) await change(old, "saved", true);
      source = "";
      filter = "saved";
      clearDiscovery();
      openArticle(old);
      return;
    }
    addingArticle = true;
    const article: FeedArticle = {
      id: JSON.stringify(["article", url]),
      feedUrl: "",
      title: url,
      url,
      published: null,
      body: "",
      saved: true,
      read: true,
      fetchedAt: new Date().toISOString(),
    };
    // Keep the link even when extraction fails. The result never replaces an existing snapshot.
    try {
      await updateArticleContent(db, article, {}, true);
      await load(article.id);
      announceChange(article.id);
      source = "";
      filter = "saved";
      clearDiscovery();
      showArticle(article);
      await importContent(article);
    } catch (error) {
      showError((error as Error).message, () => void addArticle(value));
    } finally {
      addingArticle = false;
      render();
    }
  }
  async function detectLanguage(article: FeedArticle, automatic: boolean) {
    if (detectionController || translationController || selected !== article.id)
      return;
    const controller = new AbortController();
    detectionController = controller;
    translationStatus = "原文の言語を判定中…";
    let detected = false;
    try {
      const pending = detectArticleLanguage(
        article.content?.text || article.body,
        controller.signal,
        (message) => {
          if (detectionController === controller) {
            translationStatus = message;
            render();
          }
        },
        automatic,
      );
      render();
      const language = await pending;
      if (
        detectionController !== controller ||
        controller.signal.aborted ||
        selected !== article.id
      )
        return;
      originalLanguage = language;
      speech.stop(false);
      translationStatus = `原文を${languageName(language)}と判定しました。誤っている場合は変更できます。`;
      detected = true;
    } catch (error) {
      if (detectionController === controller && !controller.signal.aborted)
        translationStatus = `原文の言語を判定できませんでした。${(error as Error).message} 原文の言語を選択して続けられます。`;
    } finally {
      if (detectionController === controller) {
        detectionController = null;
        render();
      }
    }
    if (detected && preferences.automatic) autoTranslateSelected();
  }
  function autoTranslateSelected() {
    if (
      !preferences.automatic ||
      !selected ||
      translationController ||
      detectionController
    )
      return;
    const article = articles.find((a) => a.id === selected);
    if (!article || importing.has(article.id)) return;
    const text = article.content?.text || article.body;
    if (isLinkOnly(text)) return;
    if (!targetLanguageFor(preferences)) {
      translationStatus =
        "ブラウザの言語は翻訳先の対象外です。設定で翻訳先を選択してください。";
      render();
      return;
    }
    if (
      article.translation?.sourceText === text &&
      article.translation.targetLanguage === targetLanguageFor(preferences)
    ) {
      translatedView = true;
      render();
      return;
    }
    if (!originalLanguage) {
      void detectLanguage(article, true);
      return;
    }
    if (originalLanguage === targetLanguageFor(preferences)) return;
    void translate(article, true);
  }
  async function translate(article: FeedArticle, automatic = false) {
    if (
      !db ||
      translationController ||
      detectionController ||
      !targetLanguageFor(preferences)
    )
      return;
    const controller = new AbortController();
    translationController = controller;
    const id = article.id;
    const text = article.content?.text || article.body;
    const target = targetLanguageFor(preferences);
    translationStatus =
      "翻訳を準備中… 初回は翻訳データのダウンロードが必要です。";
    try {
      const pending = translateArticle(
        text,
        originalLanguage,
        target,
        controller.signal,
        (message) => {
          if (translationController === controller && selected === id) {
            translationStatus = message;
            render();
          }
        },
        automatic,
        article.content?.codeRanges,
      );
      render();
      const result = await pending;
      if (controller.signal.aborted) return;
      await updateArticleContent(
        db,
        article,
        { translation: result },
        false,
        controller.signal,
      );
      await load(article.id);
      announceChange(article.id);
      if (translationController === controller && selected === id) {
        speech.stop(false);
        translatedView = true;
        translationStatus = `${languageName(target)}訳を保存しました。機械翻訳のため原文も確認してください。`;
      }
    } catch (error) {
      if (translationController === controller && !controller.signal.aborted)
        translationStatus = `翻訳できませんでした。${(error as Error).message} 原文は保持しています。`;
    } finally {
      if (translationController === controller) {
        translationController = null;
        render();
      }
    }
  }
  async function updateTags(
    article: FeedArticle,
    tags?: string[],
    preserveManual = false,
  ) {
    if (!db || changingTags.has(article.id)) return;
    changingTags.add(article.id);
    render();
    try {
      await setArticleTags(db, article.id, tags, preserveManual);
      await load(article.id);
      announceChange(article.id);
      if (!preserveManual) tagDrafts.delete(article.id);
    } catch (error) {
      showError(
        (error as Error).message,
        () => void updateTags(article, tags, preserveManual),
      );
    } finally {
      changingTags.delete(article.id);
      render();
    }
  }
  async function classifyPending() {
    if (!db || tagBatchController || !searchIndex.ready) return;
    const controller = new AbortController();
    tagBatchController = controller;
    const pending = articles
      .filter(needsTagClassification)
      .map((article) => article.id);
    let done = 0;
    tagProgress = `タグを判定中：0/${pending.length}件`;
    render();
    try {
      for (const id of pending) {
        while (!searchIndex.ready && !controller.signal.aborted) {
          const preparation = searchPreparation;
          if (!preparation)
            throw Error("検索の準備後にタグの判定を再試行してください。");
          await preparation;
          if (preparation === searchPreparation && !searchIndex.ready)
            throw Error("検索の準備後にタグの判定を再試行してください。");
        }
        if (controller.signal.aborted) break;
        await setArticleTags(db, id, undefined, true);
        done++;
        await load(id);
        announceChange(id);
        tagProgress = `タグを判定中：${done}/${pending.length}件`;
        // Keep the cancel button attached and focused while progress advances.
        // Rebuilding the whole list here can detach it between pointerdown/up.
        if (done % 25 === 0 || done === pending.length) {
          const progress = document.getElementById("rss-tag-progress");
          if (progress) progress.textContent = tagProgress;
        }
      }
      tagProgress = controller.signal.aborted
        ? `タグの判定を中止しました。${done}件の結果を保存済みです。`
        : `${done}件のタグ判定結果を保存しました。`;
    } catch (error) {
      tagProgress = `${done}件の判定結果を保存しました。残りは再試行できます。`;
      showError((error as Error).message, () => void classifyPending());
    } finally {
      tagBatchController = null;
      render();
    }
  }
  function showArticle(article: FeedArticle) {
    selected = article.id;
    render();
    main.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    main.scrollIntoView({ block: "start" });
  }
  function openArticle(article: FeedArticle) {
    showArticle(article);
    if (article.url && !article.content && !article.contentError)
      void importContent(article);
    else autoTranslateSelected();
    if (!article.read) void change(article, "read", true);
    if (needsTagClassification(article))
      void updateTags(article, undefined, true);
  }
  const date = (value: string | null) =>
    value
      ? new Date(value).toLocaleString("ja-JP", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "公開日時なし";
  function render() {
    if (composing) return;
    renderCloud();
    const selectedPosition = selected
      ? articlePositions.get(selected)
      : undefined;
    const article =
      selectedPosition === undefined ? undefined : articles[selectedPosition];
    if (readerIdentity !== selected) {
      cancelReading();
      readerIdentity = selected;
      const active = article;
      originalLanguage =
        articleLanguage(active?.content?.language) ||
        (active?.translation?.sourceText ===
        (active?.content?.text || active?.body)
          ? articleLanguage(active?.translation?.sourceLanguage)
          : "");
    }
    const activeId = document.activeElement?.id;
    const focused = document.activeElement;
    const selection =
      focused instanceof HTMLInputElement &&
      (focused.type === "search" || focused.id === "rss-article-tags")
        ? [focused.selectionStart, focused.selectionEnd]
        : null;
    renderError();
    if (article || listResults.parentNode !== main) main.replaceChildren();
    const counts = articleCounts.get(source || null) ?? emptyCounts;
    const pendingCount = articleCounts.get(null)?.pending ?? 0;
    let collectionStatus =
      (cloudState?.available && cloudState.interval
        ? cloudError
          ? cloudRetryCount
            ? "クラウドへの接続を再試行しています。取得済みの記事は読めます。"
            : "クラウドの状態を確認できません。設定から再確認してください。"
          : cloudState.blocked
            ? "クラウド収集：保存上限で一時停止。設定から記事を取り込んでください。"
            : `クラウド収集：${cloudState.interval}分ごとに設定済み（PC停止中も実行）`
        : collectionProblem) ||
      (!feedLockSupported()
        ? "このブラウザでは自動更新を利用できません。手動で更新してください。"
        : !refreshInterval
          ? "自動更新：オフ"
          : !navigator.onLine
            ? "自動更新：待機中（オフライン）"
            : document.hidden
              ? "自動更新：待機中（画面非表示）"
              : `自動更新：${refreshInterval}分ごと（画面の表示中）`);
    const failedImports = cloudState
      ? cloudClient.failures(cloudState).length
      : 0;
    if (failedImports)
      collectionStatus += ` ${failedImports}件の取得結果を取り込めません。設定で理由と再試行を確認してください。`;
    collectionNavigation.update({
      counts,
      filter,
      input,
      ready: !!db,
      connecting,
      discovering,
      adding: addingArticle,
      source,
      updating,
      status: collectionStatus,
      feeds: feeds.map((feed) => {
        const details: {
          text: string;
          error?: boolean;
          time?: { iso: string; text: string };
        }[] = [{ text: `ブラウザ内の最終取得 ${date(feed.fetchedAt)}` }];
        const remoteFeed =
          cloudState?.available && cloudState.interval
            ? cloudState.feeds.find((item) => item.url === feed.url)
            : undefined;
        const cloudUnsubscribePending =
          !!feed.cloudUnsubscribePending ||
          (!!feed.unsubscribed && !!remoteFeed);
        if (feed.unsubscribed)
          details.push({
            text: cloudUnsubscribePending
              ? "このブラウザでは購読解除済み。クラウドの解除は未確認です。"
              : "購読解除済み。保存した記事は引き続き読めます。",
          });
        if (
          cloudState?.available &&
          cloudState.interval &&
          !feed.unsubscribed
        ) {
          if (remoteFeed) {
            if (remoteFeed.lastSuccess !== null) {
              const iso = new Date(remoteFeed.lastSuccess).toISOString();
              details.push({
                text: "クラウド最終取得 ",
                time: { iso, text: date(iso) },
              });
            } else
              details.push({ text: "クラウドの取得はまだ成功していません。" });
          }
          details.push({
            text: remoteFeed
              ? `クラウドの次回更新の目安 ${date(new Date(remoteFeed.nextAt).toISOString())}`
              : "この配信元はクラウド未登録です。設定を更新してください。",
          });
          if (remoteFeed?.error)
            details.push({
              text: "クラウドで取得できませんでした。既存の記事を保持して再試行を待っています。",
              error: true,
            });
        } else if (
          !feed.unsubscribed &&
          refreshInterval &&
          feedLockSupported()
        ) {
          details.push({
            text: `次回更新の目安 ${date(new Date(nextFeedRefresh(feed, refreshInterval)).toISOString())}`,
          });
        }
        const error = feedProblems.get(feed.url) || feed.refreshFailure?.error;
        if (error) details.push({ text: error, error: true });
        return {
          url: feed.url,
          title: feed.title,
          details,
          retry: feedProblems.has(feed.url),
          updating: updating.has(feed.url),
          unsubscribed: !!feed.unsubscribed,
          cloudUnsubscribePending,
          subscriptionBusy: cloudBusy,
        };
      }),
    });
    renderDiscovery();
    if (discoveryPanel.parentNode !== main) main.append(discoveryPanel);
    if (article) {
      main.classList.add("rss-reading");
      main.append(readerNavigation);
      const articleNode = el("article", undefined, "rss-article");
      const title = el("h1", article.content?.title || article.title);
      title.id = "rss-current-title";
      title.tabIndex = -1;
      articleNode.append(
        el(
          "p",
          feeds.find((f) => f.url === article.feedUrl)?.title ??
            "取り込んだ記事",
          "eyebrow",
        ),
        title,
        el("p", date(article.published), "muted"),
      );
      const save = button(
        article.saved ? "保存済み · 保存を解除" : "この記事を保存",
        () => void change(article, "saved", !article.saved),
      );
      save.id = "rss-save-article";
      save.setAttribute("aria-pressed", String(article.saved));
      save.disabled = changing.has(article.id) || importing.has(article.id);
      articleNode.append(save);
      if (article.url) {
        const original = el("a", "元の記事を開く", "rss-text-link");
        original.href = article.content?.url || article.url;
        original.target = "_blank";
        original.rel = "noopener noreferrer";
        articleNode.append(original);
      }
      const tagsPanel = el("section", undefined, "rss-tag-editor");
      tagsPanel.setAttribute("aria-label", "記事のタグ");
      tagsPanel.append(
        el("h2", "タグ"),
        el("p", tagSummary(article), "rss-tag-summary"),
      );
      const tagForm = el("form");
      const tagLabel = el("label", "自分のタグを編集（カンマ区切り）");
      tagLabel.htmlFor = "rss-article-tags";
      const tagInput = el("input");
      tagInput.id = tagLabel.htmlFor;
      tagInput.value =
        tagDrafts.get(article.id) ?? article.manualTags?.join(", ") ?? "";
      tagInput.maxLength = 500;
      tagInput.addEventListener("compositionstart", () => {
        composing = true;
      });
      tagInput.addEventListener("compositionend", () => {
        tagDrafts.set(article.id, tagInput.value);
        composing = false;
        render();
      });
      tagInput.addEventListener("input", () =>
        tagDrafts.set(article.id, tagInput.value),
      );
      const saveTags = el("button", "タグを保存");
      saveTags.type = "submit";
      saveTags.disabled = changingTags.has(article.id);
      tagForm.addEventListener("submit", (event) => {
        event.preventDefault();
        void updateTags(article, tagInput.value.split(/[,、\n]/));
      });
      tagForm.append(
        el(
          "p",
          "自分のタグは配信元・Quilnaの自動タグと別に保存します。空欄で保存しても他のタグは消えません。",
          "muted",
        ),
        tagLabel,
        tagInput,
        saveTags,
      );
      const resetTags = button(
        "自分のタグを解除",
        () => void updateTags(article),
      );
      resetTags.disabled = changingTags.has(article.id);
      const reasoning = el("details");
      reasoning.append(el("summary", "自動判定の根拠"));
      if (!article.tags)
        reasoning.append(el("p", "この記事はまだ判定していません。"));
      else if (!article.tags.suggestions.length)
        reasoning.append(
          el(
            "p",
            article.tags.state === "no-content"
              ? "本文や題名に分類の手掛かりがありません。"
              : "分類に十分な手掛かりがありません。手動でタグを設定できます。",
          ),
        );
      else
        for (const suggestion of article.tags.suggestions)
          reasoning.append(
            el("p", `${suggestion.tag}：${suggestion.evidence.join("、")}`),
          );
      reasoning.append(
        el(
          "p",
          "配信元のタグ・本文・題名・原文と一致する訳文の語句から端末内で判定します。内容理解による分類ではないため、目安として使い、自分のタグで整理してください。",
          "muted",
        ),
      );
      const editor = el("details");
      editor.open = tagEditorFor === article.id;
      editor.addEventListener("toggle", () => {
        if (editor.isConnected) tagEditorFor = editor.open ? article.id : null;
      });
      editor.append(
        el("summary", "タグを編集・根拠を確認"),
        tagForm,
        resetTags,
        reasoning,
      );
      tagsPanel.append(editor);

      const importingNow = importing.has(article.id);
      documentHistory.show(
        article.content,
        importingNow,
        article.id,
        article.url,
      );
      const notice = el(
        "p",
        importingNow
          ? "保存済みの本文を確認し、必要な場合は元サイトから取り込み中… RSSの情報はそのまま読めます。"
          : article.content
            ? "元サイトから取り込んだ本文です。画像や埋め込みは省略しています。"
            : article.contentError
              ? `本文の取り込みに失敗しました：${article.contentError}`
              : "RSSで配信された本文・概要です。元サイトの本文はまだ取り込んでいません。",
        "rss-content-note",
      );
      notice.setAttribute("role", "status");
      articleNode.append(notice);
      if (article.content?.codeRanges !== undefined && article.contentError)
        articleNode.append(el("p", article.contentError, "rss-content-note"));
      if (article.content && article.content.codeRanges === undefined) {
        articleNode.append(
          el(
            "p",
            "以前に取り込んだ本文にはコードの書式情報がありません。元サイトの本文が変わっていなければ書式を取り直せます。成功後は訳文を作り直します。",
            "rss-content-note",
          ),
        );
        const restore = button(
          "コードの書式を取り直す",
          () => void importContent(article, false, true),
        );
        restore.disabled = importingNow;
        articleNode.append(restore);
        if (article.contentError)
          articleNode.append(
            el(
              "p",
              `書式を取得できませんでした：${article.contentError} 保存済み本文は保持しています。`,
              "rss-content-note",
            ),
          );
      }
      if (article.url && !article.content) {
        const acquire = button(
          article.contentError ? "本文の取得を再試行" : "本文を取り込む",
          () => void importContent(article),
        );
        acquire.disabled = importingNow;
        articleNode.append(acquire);
      }
      const originalText = article.content?.text || article.body;
      const hasText = !!article.content || !isLinkOnly(article.body);
      const validTranslation =
        article.translation?.sourceText === originalText &&
        article.translation.targetLanguage === targetLanguageFor(preferences)
          ? article.translation
          : undefined;
      const displayTranslation = translatedView && validTranslation;
      const text = displayTranslation ? displayTranslation.text : originalText;
      let readingTools: HTMLElement | null = null;
      if (hasText) {
        const shortcuts = el("nav", undefined, "rss-reading-shortcuts");
        shortcuts.setAttribute("aria-label", "記事内の移動");
        const jumpToBody = readingJump("本文を読む", "rss-article-body");
        const jumpToTools = readingJump("翻訳・読み上げ", "rss-reading-tools");
        shortcuts.append(
          jumpToBody,
          readingJump("ハイライト・メモ", "rss-highlights"),
          readingJump("自分の学び", "rss-learning-records"),
          readingJump("学ぶきっかけ", "rss-learning-cues"),
          readingJump("情報のつながり", "rss-connections"),
          readingJump("関係図", "rss-graph"),
          jumpToTools,
        );
        articleNode.append(shortcuts);
        const tools = el("section", undefined, "rss-reader-tools");
        tools.id = "rss-reading-tools";
        tools.tabIndex = -1;
        tools.setAttribute("aria-label", "翻訳と読み上げ");
        const langLabel = el("label", "原文の言語");
        langLabel.htmlFor = "rss-original-language";
        const language = el("select");
        language.id = langLabel.htmlFor;
        const unknown = el("option", "選択してください");
        unknown.value = "";
        language.append(unknown);
        for (const [code, name] of readerLanguages) {
          const option = el("option", name);
          option.value = code;
          language.append(option);
        }
        language.value = originalLanguage;
        language.disabled = !!translationController || !!detectionController;
        language.addEventListener("change", () => {
          originalLanguage = language.value;
          speech.stop(false);
          render();
        });
        tools.append(langLabel, language);
        if (browserLanguageDetector()) {
          const detect = button(
            detectionController ? "言語を判定中…" : "原文の言語を判定",
            () => void detectLanguage(article, false),
          );
          detect.disabled =
            !!detectionController || !!translationController || importingNow;
          tools.append(detect);
        }
        if (!targetLanguageFor(preferences))
          tools.append(
            el(
              "p",
              "ブラウザの言語は翻訳先の対象外です。設定で翻訳先を選択してください。",
              "muted",
            ),
          );
        const translation = button(
          translationController
            ? "翻訳中…"
            : `${languageName(targetLanguageFor(preferences)) || "選択した言語"}に翻訳`,
          () => void translate(article),
        );
        translation.disabled =
          !!translationController ||
          !!detectionController ||
          !targetLanguageFor(preferences) ||
          importingNow ||
          !browserTranslator() ||
          !originalLanguage ||
          originalLanguage === targetLanguageFor(preferences);
        tools.append(translation);
        if (!browserTranslator())
          tools.append(
            el(
              "p",
              "このブラウザは端末内翻訳に対応していません。外部サービスには送信していません。",
              "muted",
            ),
          );
        else
          tools.append(
            el(
              "p",
              "翻訳は端末内で行います。初回は翻訳データをダウンロードします。原文の言語を確認して翻訳してください。",
              "muted",
            ),
          );
        if (translationController || detectionController)
          tools.append(
            button("翻訳を中止", () => {
              translationController?.abort();
              translationController = null;
              detectionController?.abort();
              detectionController = null;
              translationStatus = "翻訳を中止しました。";
              render();
            }),
          );
        if (validTranslation)
          tools.append(
            button(
              displayTranslation
                ? "原文を読む"
                : `${languageName(targetLanguageFor(preferences)) || "選択した言語"}訳を読む`,
              () => {
                speech.stop(false);
                translatedView = !translatedView;
                render();
              },
            ),
          );
        if (translationStatus) {
          const status = el("p", translationStatus);
          status.setAttribute("role", "status");
          tools.append(status);
        }
        const spokenLanguage = speechLocaleFor(
          preferences,
          displayTranslation
            ? displayTranslation.targetLanguage
            : originalLanguage,
        );
        const voiceLabel = el("label", "読み上げ音声");
        voiceLabel.htmlFor = "rss-speech-voice";
        const voices = el("select");
        voices.id = voiceLabel.htmlFor;
        const choose = el("option", "音声を選択してください");
        choose.value = "";
        choose.disabled = true;
        voices.append(choose);
        for (const voice of speech.voices(spokenLanguage)) {
          const option = el(
            "option",
            `${voice.name || voice.lang} (${voice.lang})${voice.default ? " · 既定" : ""}`,
          );
          option.value = voiceKey(voice);
          voices.append(option);
        }
        const selectedVoice = speech.selectedVoice(spokenLanguage);
        voices.value = selectedVoice ? voiceKey(selectedVoice) : "";
        voices.disabled = !speech.voices(spokenLanguage).length;
        voices.addEventListener("change", () =>
          speech.selectVoice(spokenLanguage, voices.value),
        );
        tools.append(voiceLabel, voices);
        const rateLabel = el("label", "読み上げ速度");
        rateLabel.htmlFor = "rss-speech-rate";
        const rate = el("select");
        rate.id = rateLabel.htmlFor;
        for (const value of [0.75, 1, 1.25, 1.5, 2]) {
          const option = el("option", `${value}倍`);
          option.value = String(value);
          rate.append(option);
        }
        rate.value = String(speechRate);
        rate.addEventListener("change", () => {
          speechRate = Number(rate.value);
          speech.stop(false);
          render();
        });
        tools.append(rateLabel, rate);
        const speak = button("表示中の本文を読み上げ", () =>
          speech.start(text, spokenLanguage, speechRate),
        );
        speak.disabled = !speech.supported || speech.state !== "idle";
        tools.append(speak);
        if (speech.state !== "idle")
          tools.append(
            button(
              speech.state === "paused"
                ? "読み上げを再開"
                : "読み上げを一時停止",
              () => speech.togglePause(),
            ),
            button("読み上げを停止", () => speech.stop()),
          );
        const speechStatus = el(
          "p",
          speech.supported
            ? speech.message || speech.voiceNotice(spokenLanguage)
            : "このブラウザでは読み上げを利用できません。",
          "muted",
        );
        speechStatus.setAttribute("role", "status");
        tools.append(speechStatus);
        readingTools = tools;
      }
      const body = el("div", undefined, "rss-article-body");
      body.id = "rss-article-body";
      body.tabIndex = -1;
      body.lang = displayTranslation
        ? displayTranslation.targetLanguage
        : originalLanguage;
      if (!hasText)
        body.append(
          el("p", "本文なし・リンク情報のみです。元の記事を開いてください。"),
        );
      if (!article.content && article.body)
        body.append(el("h2", hasText ? "RSSの本文・概要" : "RSSのリンク情報"));
      if (displayTranslation)
        body.append(
          el(
            "p",
            `${languageName(displayTranslation.targetLanguage)}訳（機械翻訳）`,
            "muted",
          ),
        );
      const sourceText = el("div", undefined, "rss-source-text");
      body.append(sourceText);
      if (hasText) {
        const readingView = {
          articleId: article.id,
          title: article.content?.title || article.title,
          url: article.content?.url || article.url,
          text,
          original: originalText,
          view: displayTranslation
            ? ("translation" as const)
            : ("original" as const),
          language: displayTranslation
            ? displayTranslation.targetLanguage
            : originalLanguage,
          ranges: displayTranslation
            ? displayTranslation.codeRanges
            : article.content?.codeRanges,
        };
        const panel = highlights.mount(readingView, sourceText);
        articleNode.append(
          body,
          panel,
          quoteConnections.mount(article.id),
          learningRecords.mount(article.id),
          learning.mount(readingView),
          connections.mount(article, relationLibraryRevision),
          graph.mount(article, relationLibraryRevision),
          tagsPanel,
        );
      } else {
        highlights.detach();
        quoteConnections.detach();
        learningRecords.detach();
        learning.detach();
        connections.detach();
        graph.detach();
        appendArticleText(sourceText, text, article.content?.codeRanges);
        articleNode.append(body, tagsPanel);
      }
      if (readingTools) articleNode.append(readingTools);
      articleNode.append(documentHistory.root);
      main.append(articleNode);
    } else {
      documentHistory.show(undefined);
      highlights.detach();
      quoteConnections.detach();
      learningRecords.detach();
      learning.detach();
      connections.detach();
      graph.detach();
      main.classList.remove("rss-reading");
      listHeading.textContent =
        filter === "saved"
          ? "保存した記事"
          : filter === "unread"
            ? "未読の記事"
            : "すべての記事";
      if (listResults.parentNode !== main)
        main.append(
          listHeading,
          listLede,
          searchLabel,
          searchField,
          tagFilterLabel,
          tagsSelect,
          listResults,
        );
      if (searchField.value !== searchQuery) searchField.value = searchQuery;
      const desiredOptions = [
        ["", "すべてのタグ"],
        ["state:未処理", "未処理"],
        ["state:分類できず", "分類できず"],
        ["state:本文なし", "本文なし"],
        ["state:手動設定", "手動設定"],
        ...Array.from(tagCounts)
          .sort(([a], [b]) => a.localeCompare(b, "ja"))
          .map(([tag, count]) => [`tag:${tag}`, `${tag} · ${count}`]),
      ];
      if (tagFilter && !desiredOptions.some(([value]) => value === tagFilter))
        desiredOptions.push([tagFilter, `${tagFilter.slice(4)} · 0`]);
      const existingOptions = new Map(
        Array.from(tagsSelect.options, (option) => [option.value, option]),
      );
      for (const [index, [value, label]] of desiredOptions.entries()) {
        const option = existingOptions.get(value) ?? el("option");
        option.value = value;
        if (option.textContent !== label) option.textContent = label;
        if (tagsSelect.options[index] !== option)
          tagsSelect.insertBefore(option, tagsSelect.options[index] ?? null);
        existingOptions.delete(value);
      }
      for (const option of existingOptions.values()) option.remove();
      if (tagsSelect.value !== tagFilter) tagsSelect.value = tagFilter;
      const query = displayedQuery.trim();
      const key = JSON.stringify([query, source, filter, tagFilter]);
      if (key !== paginationKey) {
        paginationKey = key;
        pageNumber = 0;
      }
      const matched =
        query && searchIndex.ready ? searchIndex.search(query) : null;
      const preparing = !!query && !searchIndex.ready;
      // Sparse query matches already have IDs. Restore library order without
      // scanning every article again; broad/no-query results use the full list.
      const candidates =
        matched && matched.size < articles.length / 4
          ? Array.from(matched, (id) => articlePositions.get(id))
              .filter((position): position is number => position !== undefined)
              .sort((a, b) => a - b)
              .map((position) => articles[position])
          : articles;
      const result = articlePage(preparing ? [] : candidates, {
        matched,
        source,
        filter,
        tagFilter,
        page: pageNumber,
        pageSize,
      });
      pageNumber = result.page;
      listView.update({
        items: result.items,
        metadata: (item) =>
          `${feeds.find((f) => f.url === item.feedUrl)?.title ?? "取り込んだ記事"} · ${date(item.published)}${item.saved ? " · 保存済み" : ""}${item.read ? " · 既読" : " · 未読"}`,
        status:
          searchProblem ||
          (preparing
            ? "検索を準備中です。入力した条件で準備後に検索します。"
            : `${result.count}件 · ${pageNumber * pageSize + (result.count ? 1 : 0)}–${Math.min((pageNumber + 1) * pageSize, result.count)}件を表示`),
        classify: tagBatchController
          ? "タグを判定中…"
          : pendingCount
            ? `未処理${pendingCount}件のタグを判定`
            : "",
        classifying: !!tagBatchController,
        classifyDisabled: !!tagBatchController || !searchIndex.ready,
        progress: tagProgress,
        retry: !!searchProblem,
        clear: !!query,
        pagination: result.count > pageSize,
        previousDisabled: pageNumber === 0,
        nextDisabled: (pageNumber + 1) * pageSize >= result.count,
        empty: result.count
          ? ""
          : query
            ? preparing
              ? "検索準備中です。検索を解除すると記事を読めます。"
              : "一致する記事はありません。語句や絞り込みを変更してください。"
            : connecting
              ? "保存した記事を読み込んでいます…"
              : !feeds.length
                ? "気になるサイトを追加すると、ここに記事が届きます。サイトのURLから探すか、公開フィードから試してください。"
                : filter === "saved"
                  ? "まだ保存した記事はありません。記事を開いて「この記事を保存」を押してください。"
                  : filter === "unread"
                    ? "未読の記事はありません。"
                    : "まだ記事がありません。配信元を更新してください。",
      });
    }
    // Persistent reader panels are detached and reattached during a refresh.
    // Keep their focused controls, including summary/buttons without an ID.
    const restored =
      focused instanceof HTMLElement &&
      focused !== document.body &&
      focused.isConnected
        ? focused
        : activeId
          ? document.getElementById(activeId)
          : null;
    if (restored) {
      restored.focus({ preventScroll: true });
      if (selection && restored instanceof HTMLInputElement)
        restored.setSelectionRange(selection[0], selection[1]);
    }
  }
  channel?.addEventListener("message", (event) => {
    const id =
      typeof event.data?.articleId === "string" &&
      event.data.articleId.length <= 40000
        ? event.data.articleId
        : undefined;
    void load(id)
      .then(render)
      .catch(() =>
        showError(
          "保存領域を再読み込みできませんでした。",
          () => void connect(),
        ),
      );
  });
  await connect();
  if (speech.supported) {
    // The reader owns this document. Keep the listener through bfcache restores;
    // navigation destroys it with the document, while pagehide already stops speech.
    speechSynthesis.addEventListener?.("voiceschanged", () => render());
  }
  renderCloud();
  await checkCloud();
  collector.start();
}
