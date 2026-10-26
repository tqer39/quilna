# Browser RSS collection and deployment choices

[English](browser-rss.md) | [日本語](browser-rss.ja.md)

## Run and try

Run `mise exec -- npm run dev` and open <http://127.0.0.1:5173/>.
The home screen collects information. In **サイトを追加**, enter a site, article or RSS/Atom URL and select **フィードを探す**.
Domains without a scheme use HTTPS. Choose a named feed with **登録して読む**; discovered feeds are not subscribed automatically.
Zenn and Cloudflare Blog remain one-click examples.
Open an article, select **この記事を保存**, return to the list and select **保存した記事**.
Reload to check the saved copy. **サンプル教材** opens the existing fixed CAA lesson separately; collection does not generate it.

Discovery reads the page's advertised RSS/Atom alternate links, including relative URLs and its HTML base URL.
If an article page has no advertised feeds, it also checks the final site's home page, within the same 16-second client deadline.
Up to 20 distinct candidates are shown. Changing the input cancels the search and discards stale results.
The discovery HTML remains in an inert template: scripts, images and embedded frames are never mounted or executed.
Chosen feeds and all redirects still pass the existing public-HTTPS and DNS checks.
Sites that do not advertise a feed show a clear message and offer standalone article import; name/topic search, arbitrary crawling, guessed feed paths and generating feeds from feedless sites are not implemented.
Previously collected articles remain readable and saveable during discovery or failure.

RSS acquisition, page discovery and article import run inside the local Vite process through `/api/feeds/fetch`; discovery-mode requests allow HTML responses.
Article extraction uses `@mozilla/readability`, a shared browser dependency. No cloud deployment, login or paid model connection is added.
`npm run build` creates static assets but does not create or deploy the RSS acquisition service.
`vite preview` does not provide this endpoint. The optional [cloud collector](cloud-feed-collection.md) provides authenticated Workers acquisition for three explicitly supported publisher hosts; it is disabled by default.

## Viewer designs

**設定 → ビューアのデザイン** offers three built-in templates: **Studio** (default, bright cards), **Editorial** (warm paper, serif article text and a single-column list), and **Focus** (dark surfaces and a quiet single-column list).
They share navigation, controls and article data. Switching applies immediately without interrupting the selected article or changing saved/read flags.
The choice is stored for this browser origin in `quilna.reader.design.v1`; unknown values use Studio. Storage failures are visible, and a failed save still applies to the current page.
Design choices use a labeled radio group with keyboard navigation and miniature previews. Controls retain a minimum 44 CSS-pixel height, narrow screens use a single column, and reduced-motion preferences suppress transitions.
The article body comes before tag editing and translation/read-aloud controls. In-article links move focus to the body or tools without leaving the current article; narrow screens also offer an **記事へ** shortcut past collection controls.
Color, type, spacing and surface tokens are grouped in `src/reader-design.css`. These templates currently apply to the browser RSS viewer; the sample lesson and native apps are not restyled. Native implementation and device verification remain pending under the browser-first product sequence.

## Automatic feed collection

Subscribed feeds refresh every 15 minutes by default. **設定 → RSSの自動更新** offers 15, 30, 60 minutes or off; the choice is stored for this browser origin and updates other open tabs.
This collector runs only while the Quilna page is visible and the browser reports online. Hiding the page, going offline or turning collection off prevents new automatic requests; requests already started may finish within their existing 16-second timeout. Visibility/online restoration checks overdue feeds. It does not run after the page/browser closes, and the UI does not claim otherwise. Collection while the PC sleeps or is off uses the separately enabled [cloud collector](cloud-feed-collection.md). The browser waits for cloud status before starting foreground collection, avoiding a duplicate initial request.
A 15-second scheduler check handles due feeds without overlapping its own cycles. Each origin has two Web Lock slots and an exclusive lock per feed, shared by manual and automatic refresh. Automatic requests reread the persisted feed after acquiring the lock, so another tab's completed update prevents a duplicate request. Busy slots are retried by a later automatic check; a manual request reports that other updates are running.
Browsers without Web Locks explicitly disable automatic collection; manual refresh still has a two-request limit within each tab. No cross-tab guarantee is made for that fallback.

A failed subscribed feed keeps its articles and last successful acquisition time. The failure count and retry deadline are saved in IndexedDB: 5, 10, 20, 40, then 60 minutes (capped), including across reloads. A successful refresh resets this failure state. The feed panel shows the error and next due time; actual execution may be later because the page is hidden, offline or waiting for a slot. Manual retry can bypass the delay. If the retry deadline cannot be saved, automation stops with an explicit message instead of repeatedly hitting the source; select the setting again after resolving storage trouble.
A feed refresh continues to deduplicate by entry identity and preserve saved snapshots, read flags and manual tags. Discovery itself does not silently subscribe a feed. When no RSS/Atom feed is found, **この記事を取り込んで保存** imports the originally entered article URL, not the home page used as a discovery fallback.
See [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) and [page visibility](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API). No paid adapter, generated RSS, remote cron or new external service is enabled.

On 2026-10-24, the combined desktop/mobile reader suite passed 94 tests, including 12 automatic-collection cases. Controlled clocks and network responses covered due times, visibility/offline waits, persisted retry delays, cross-tab concurrency, settings, storage failure and standalone-article fallback. The actual in-app browser also fetched a public Zenn feed, displayed its next update time and retained a changed interval after reload. This was not a real-time 15-minute collection soak test. Unit/server tests, build and lint passed; PR/CI integration and owner usability acceptance remain pending.

## What is saved

Subscriptions, collected article text, read flags and saved flags use IndexedDB database `tsumiki.rss.v1`.
The existing sample lesson's localStorage history is separate and preserved.
State is specific to the browser profile and origin, including the port. Another browser, port or device has separate data.
Clearing site data or browser eviction can remove it; this prototype has no export/backup or device synchronization.
See [browser storage behavior](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

A saved article keeps its collected title, date and text when a later feed refresh changes the same entry.
Refresh does not delete older articles, read flags or saved flags. Multi-tab changes use IndexedDB transactions and change notifications.
Failed writes do not claim success, and the error includes an explicit retry.
A slow or failed feed does not prevent reading previously collected articles.

Opening a feed article attempts to import the original page once, while keeping the RSS text readable.
Alternatively, enter an article URL and select **記事として取り込む** to save it without subscribing to a feed.
A failed import retains the saved link or RSS text and shows the failure with **本文の取得を再試行**.
Links-only feed metadata is labeled explicitly; it is not presented as article prose.
Mozilla Readability extracts text from inert HTML. The imported original is stored separately from the feed text and is retained across feed refreshes.
Imported `pre` and `code` elements retain their text and UTF-16 ranges. Code blocks preserve indentation and newlines, and render in a horizontally scrollable block; inline code stays within its paragraph. Rendering creates text nodes, never mounts the source HTML, and rejects invalid saved ranges without deleting the library.
Older imports remain readable. **コードの書式を取り直す** fetches formatting only when the source still matches the saved text after the old whitespace normalization; a changed source or failed fetch preserves the existing original and translation. A successful formatting upgrade keeps read/saved flags and manual tags, and clears the old translation so it can be translated again with code protection. RSS-only text and old imports without formatting metadata cannot reliably distinguish code.
Login-required, script-rendered and restricted pages may not yield article text; no cookies or authentication are forwarded and access restrictions are not bypassed.
Extraction is heuristic and may omit content; it does not guarantee a complete copy of every page.
Images, executable markup and embedded content are not rendered. The original article opens only when selected.
Limits are 50 subscriptions, 200 entries per feed response, 40,000 characters of RSS text, 200,000 characters of imported text and 400,000 characters of translated text.
Over-limit imports fail visibly rather than silently saving a truncated original.
Textbook generation and offline app installation are not included in this reader slice. See [cloud collection](cloud-feed-collection.md) for collection after the page closes.

### Highlights and notes

The article view supports selecting a passage and choosing **選択範囲をハイライト**. The action appears near the bottom of the viewport while a passage is selected. **ハイライト・メモ** also offers exact-quote lookup for keyboard and touch use; repeated text requires choosing an occurrence instead of silently using the first match. A quote can have an optional note, be reopened from its list, edited or explicitly deleted after confirmation. Source HTML and notes are rendered as text, including quotes crossing inline code or paragraphs.

Records use the separate IndexedDB database `quilna.highlights.v1`, without upgrading or rewriting the article database. Each record retains article identity, source title/URL, original versus translation, language, SHA-256 of the original/displayed text and view identity, UTF-16 offsets, the exact quote, creation time, note and edit revision. New quotes use the title and URL shown when the draft is created; existing citations retain their original metadata. Matching text and version are required to place a mark. A changed original, replaced translation or another language leaves the old quote and note visible in the list, labeled as another version; it is not relocated or deleted. The record keeps the quote, not a complete historical article snapshot. Read, saved and highlighted remain separate; a highlight is not proof of understanding.

Quotes are limited to 4,000 UTF-16 units, notes to 2,000 and records to 200 per article across versions. Count/revision checks and writes share one transaction so simultaneous tabs cannot bypass the limit or silently overwrite a newer memo. While a write is pending, editing another quote is disabled. Failed writes preserve the draft and failure message even when another tab triggers a refresh, allowing explicit retry. Corrupt or unreadable records block editing while retaining the article and stored data; **ハイライト一覧を再読み込み** retries the read. Changing articles or language views clears an unsaved editing draft, but an already submitted save remains associated with its original article. Late reads and saves cannot replace another reading context. These records have the same origin/profile, eviction and no-backup limitations as the article library; they are not synchronized to the cloud.

This is the first part of [Issue #73](https://github.com/tqer39/quilna/issues/73). Learning-point extraction, related-item suggestions, explicit connections and a relationship map remain unimplemented; no article or note is sent to an external analysis service.

### Translation and speech

Select the original language, then the translation button. The default locale follows the first browser language/region preference. **設定 → ロケール（翻訳・読み上げ）** offers explicit locales such as Japanese (Japan), English (US/UK), and language-only choices. Existing explicit target settings are retained. Translation uses the locale's language; the region selects matching speech voices, not a guaranteed regional translation style or an app-wide UI language. **記事を開いたら自動翻訳** is persisted and off initially. Translation uses the browser's built-in Translator API only; the first use may download language data.
Availability depends on the browser, language pair and device. Unsupported browsers show an explicit notice and do not send the article to an external translation service.
One successful translation per article is saved separately with its source text and target language; **原文を読む** / **日本語訳を読む** switches views without replacing the original. The button label follows the chosen target. A different target replaces only the previous translation after success; it is never displayed as a translation into the new target.
Code identified during import is excluded from translation and copied unchanged into the translated view, including inline identifiers. Prose on either side of inline code is translated separately; this can reduce fluency. Code-like text that the publisher did not mark as `pre`/`code` is not inferred or protected.
Automatic translation reuses a saved translation only when the source text and target match. It uses the imported HTML language. When that is missing, the on-device Language Detector API checks samples of up to 2,000 characters from the beginning, middle and end. The samples must agree with confidence of at least 0.8; short text, unsupported languages, disagreement and low confidence require a manual language choice. This is a heuristic, not proof that the full article has one language. **原文の言語を判定** also allows an explicit check and correction. An unsupported browser target is disclosed instead of silently translating into another language. Background detection or translation asks for a button click when the browser needs activation to prepare model data. Browser language changes cancel pending work when **ブラウザに合わせる** is selected.
Cancellation, disabling automatic translation, changing the target, or switching articles discards pending translations; failures retain the original and allow another attempt.
Machine translation can be inaccurate. External translation services require a separate decision.

**表示中の本文を読み上げ** speaks the displayed original or translation using a matching on-device voice.
**読み上げ音声** lists only local voices for the displayed language. A saved locale-specific choice takes precedence. A legacy language-only choice is reused only when its voice matches the requested locale. Otherwise exact-locale voices are preferred, then other voices of the same language; within that pool the browser-reported default or a single available voice is selected. Multiple non-default voices require an explicit choice instead of silently selecting the first installed voice. A missing saved voice also requires reselection. The choice is saved per language/region in this browser; storage failure is shown while allowing the current choice to work. Newly available voices update the list. Changing voices stops the previous reading.
Pause, resume, stop and speed controls are provided. Leaving an article or changing language/view stops speech.
Starting again after a paused stop, article navigation or speed change clears the speech engine's paused state after cancelling the previous queue, so the new reading can start without replaying cancelled text.
If a chunk finishes just before pause, its delayed completion event preserves the paused controls; one resume action continues the next chunk.
Missing APIs, missing local voices and speech failures are shown explicitly; network voices are not used.
The OS may require installing a voice. Translation and speech controls are covered with deterministic browser test doubles; these do not establish translation quality or audible output on every host.
See the [Language Detector API](https://developer.chrome.com/docs/ai/language-detection), [Translator API](https://developer.chrome.com/docs/ai/translator-api) and [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis).
Reading cached articles during a feed/API outage is supported while the local app server remains available;
reopening the app with that server stopped is not implemented.

On 2026-10-24, an isolated in-app browser origin imported a public article, saved its original, and produced and saved a Japanese translation with the real browser Translator API. Speech start/pause/stop controls were exercised with the real browser API; acoustic quality was not assessed. The language detector API was exposed but its model was unavailable in this host; its failure/manual-selection path was checked in the real UI, while successful, uncertain, mixed-language and cancelled detections were checked with test doubles. This is not full product usability acceptance.

On 2026-10-27 the owner confirmed audible Japanese on the private deployment but reported noisy English that ended quickly (#69). This Mac's English voice list began with Albert; Samantha and Daniel were also available. Voice selection removes that implicit first-voice dependency, but manual acoustic verification remains required. Automated browser speech also ended immediately for Japanese that the owner could hear manually, so those event observations do not prove the host's audible behavior or resolution of the English symptom.
The owner then manually tested the local corrected reader with **Samantha (en-US)** and confirmed normal English audio. This confirms that voice on this Mac; other voices, devices, and the deployment remain separate checks.

## Article tags

New RSS entries and imported originals are classified locally when saved; a new matching translation recomputes the automatic suggestions. No model call or external tagging service is used.
The version 1 rules in `src/article-tags.ts` offer eight non-exclusive categories: technology/development, AI/machine learning, science/research, business/economy, life/health, tutorials/explanations, reviews and news. The UI uses Japanese labels.
Classification checks NFKC-normalized, case-folded title, original and a translation whose source still matches. Each distinct dictionary term counts once: a title match scores two, a body-only match one; a category needs two points. Latin terms use word boundaries. Repeated copies of one body term do not increase confidence.
The reader shows the matched terms under **自動判定の根拠**. This is a Japanese/English keyword heuristic, not semantic understanding or a quality guarantee. Other languages may classify after a Japanese/English translation is saved. It may miss relevant articles or classify incidental mentions; review and correct tags as needed.

**タグを編集・根拠を確認** allows a comma-separated replacement set (at most 12 tags, 30 characters each). Manual tags are normalized and deduplicated; an empty set deliberately removes all effective tags. Corrections are stored separately and override automatic suggestions until **自動判定に戻す** is selected. Refresh, original import, translation and bulk classification preserve corrections and the latest read/saved flags.
The current record is read and updated in one IndexedDB write transaction. A failure retains the previous tags and the editing draft, with an explicit retry. Effective tags participate in text search and can be combined with source, saved/unread and query filters. Counts next to tag choices cover the whole local library.

Existing records without tags show **未処理** and are classified when opened; **未処理…件のタグを判定** processes the remaining records sequentially without fetching their sources. It can be stopped between records, retaining completed results. A link without a body shows **本文なし**; insufficient evidence shows **分類できず**. These states can be filtered separately. User changes show **手動設定**, including an intentionally empty set.
The schema adds optional fields to existing records; it does not clear the database or change its version. Tags are local to this browser like the articles themselves.

## Local article search

The list searches titles, RSS text, imported originals and saved translations that still match their original, and effective tags.
Search uses NFKC normalization, case folding and whitespace-separated AND terms, with substring matching for Japanese.
Unread, saved, source and tag filters intersect the search results. Results are ordered by date then stable ID and paginated in groups of 50; pagination does not truncate the searchable corpus.
IME composition retains the input until conversion completes. Clearing the query restores browsing.
Background updates retain the connected search input and tag selector while refreshing options, counts and results, so cross-tab writes do not close an active tag selection.
The result list also retains unchanged rows and controls instead of recreating them on every input. Rows are keyed by article ID, with retained nodes bounded to the current page; changed text, metadata and ordering still update. Opening a row resolves its ID against the current library, so a reused button cannot open a captured older article or a deleted record. This reduces DOM allocation and preserves keyboard focus for unchanged rows; it does not bypass searching, filtering or result correctness checks.
An in-memory search representation is prepared in yielding batches; a newer library load supersedes older preparation.
Library loading reads articles in batches of at most 500 within one readonly transaction covering feeds and articles. The next request is enqueued in the current request's success callback, preserving one consistent snapshot while limiting the size of each native IndexedDB result. Only the completed, validated library is published; invalid later batches or an aborted transaction reject the whole read without changing stored data. This bounds individual read results, not total library/search memory, and does not move initial preparation into the search latency measurement.
While preparation is pending, existing articles can still be browsed with the query cleared; entered searches wait for the complete representation rather than showing partial matches.
The representation is rebuilt after reload. Up to 16 recent queries are cached within an aggregate budget of 80,000 result IDs; broad results can share that budget, and least-recent queries are evicted when updates or additions exceed it; single-article writes update their membership, and full preparation/invalidation clears them. Returned result sets are independent snapshots. A single-article write or cross-tab notification reads and reindexes only that article; bulk feed updates rebuild the representation. IndexedDB originals remain authoritative.
Menu counts are maintained for the whole library and each source when committed article snapshots are loaded or replaced; the global unclassified count is maintained with them. Search input reads these counts without scanning all articles, including when a query matches nothing. Bulk reloads rebuild the counts, and single-article updates remove the old contribution before adding the new one. Sparse search matches are mapped to their current library positions and sorted before the existing filters and pagination, preserving the same date/ID order.

On 2026-10-27, Linux CI at `b88ec73bc98a35a5249cb61213f7e117b963d3a0` passed all 238 functional browser tests but failed the dense-tag search gate: one continuous-write manual-tag query took 204.4 ms. The [failed run and measurements](https://github.com/tqer39/quilna/actions/runs/40372100340) remain evidence. The allocation and sparse-candidate changes above address unnecessary rendering work; neither the 200 ms threshold nor the sample counts were relaxed. Hosted-CI validation is separate from local results. A later Linux run at `24ebc1d9023ca7577ee97807ea4f993511b0f85c` passed 240 functional tests but recorded 230.5 ms for the same broad query under continuous writes. That query matches 33,333 articles, exceeding the old per-query cache cap and forcing repeated full-text scans. The aggregate cache budget above keeps the prior overall ID bound while allowing that broad query to be maintained incrementally.

A later Linux CI run at `d04e31263ca31984de382bd5cc0553a2c78a9b89` passed all 250 functional tests and five of six design/search conditions, but Studio recorded 228.2 ms for an all-matching tag filter under continuous writes ([failure evidence](https://github.com/tqer39/quilna/actions/runs/40381237355)). Filtering now checks automatic suggestions directly instead of allocating a tag array per article, and counts all matches while retaining only the requested and final pages. If a background update removes the current page, the view clamps to the last remaining page. The 200 ms gate and full result counts are unchanged.

At `18a09e7bce8f511a1c864304162187ccf5181524`, the first [CI attempt](https://github.com/tqer39/quilna/actions/runs/40383332710) exceeded the 15-minute job limit after browser dependencies took 12m33s to install. The same-source retry passed 250 functional tests and five search conditions, but recorded 213.4 ms for an Editorial dense-tag no-match query under a held write. All measurements are retained. The metadata counts above remove a full-library traversal that still occurred on that path; the log alone does not isolate the entire latency spike. Acceptance still requires the unchanged 200 ms gate.

The search configuration runs the same baseline and dense-tag gate for each of Studio, Editorial and Focus (six tests, 2,700 samples total). Each project seeds only its design preference before loading the isolated page; the corpus, queries, contention groups, timing boundaries and 200 ms limit are identical. Results are separated by project in the output directories.

Run `npm run test:search-performance` for the isolated browser gate (`127.0.0.1:5199`, disposable browser profile). It uses 100,000 originals of approximately 2 KB and corresponding Japanese translations of approximately 2 KB, 30 first/repeated samples per fixed query, correctness oracles, all-page traversal, and idle/held-write/continuous-commit groups.
A separate dense-tag run retains that text corpus: all articles have eight automatic suggestions, 33,333 have twelve overriding manual tags, and the others use their automatic tags. It keeps the three baseline queries and adds manual-tag text search, a tag/query intersection, an all-matching tag filter and a manual-state filter (630 samples across the same three groups, versus 270 baseline samples). Filter timing starts at the change event; query timing starts at input dispatch. Both end after two animation frames and correct identities/counts. The writer also changes a manual tag; the updated tag must become searchable. All 1,000 query matches and all 333 tag/query intersection matches are traversed separately for correctness.
Measure input dispatch through painted correct results separately from initial DB loading and search preparation; retain every sample and failures, and verify successful writer commits inside contention groups.
On 2026-10-24, local headless Chromium 156.0.8078.4 on macOS passed all 270 input-to-render samples: idle maximum 36.0 ms, held-write maximum 36.1 ms, and continuous-write maximum 59.9 ms (108 successful writer commits).
The gate also verified that changed originals and translations became searchable, and traversed all 1,000 matches without omissions or duplicates.
Initial database loading and search preparation took 2,324 ms separately; fixture creation took 1,121 ms. These are local synthetic measurements, not physical-phone or universal latency guarantees. Pagination traversal is checked for correctness, not included in the 270 timing samples.
After adding tags, the unchanged 100,000-article gate passed again on the same browser: idle maximum 34.1 ms, held-write maximum 48.4 ms, continuous-write maximum 64.5 ms, 270 samples and 128 writer commits. Preparation took 2,333 ms and fixture creation 1,126 ms. This fixture does not assign tags; tag correction/filter correctness is covered separately, not a measured tag-filter workload.
The first dense-tag attempt on 2026-10-24 timed out during a filter selection under continuous writes: background renders detached the select. Its 540 completed samples (maximum 72.3 ms) are retained as a failed run, not a passing gate. After retaining connected list controls, the independently reviewed benchmark and source passed both runs on local macOS / Node 26.12.1 / Chromium 156.0.8078.4: baseline 270 samples, maximum 44.1 ms, 139 commits, 2,330 ms preparation; dense tags 630 samples, maximum 77.0 ms, 319 commits, 2,470 ms preparation. All measured samples were below 200 ms; both full traversals and changed-tag propagation passed. Fixture creation was 1,074 / 1,349 ms respectively. The source and test SHA-256 manifest accompanies retained local results; this result does not establish physical-device or hosted-CI acceptance.
Raw JSON is written under `.local-state/search-performance/results/`; source hashes are retained with the local validation evidence. No personal database is used.
On 2026-10-24, the Linux CI run for `6e3427b6a74ea7ccdc4b27fa17084a9a2914f447` failed this gate with one continuous-write sample at 243.1 ms; its [failure evidence](https://github.com/tqer39/quilna/actions/runs/40058899306) is retained. After adding the bounded query cache, the unchanged local macOS/Chromium gate passed all 270 samples with a maximum of 44.8 ms and 2,332 ms of separate loading/preparation. This local repair result does not establish a passing Linux CI result.
Browser/OS, source identity, corpus sizes and timings must accompany subsequent results. Native 100 ms measurements do not establish this browser gate.

## Where a backend is needed

| Interface / requirement | Acquisition and storage | Cloud backend required? |
| --- | --- | --- |
| Current browser on this PC | Local Node/Vite RSS acquisition; browser IndexedDB | No. The local process must be running; updating RSS needs internet access. |
| Browser on PC and smartphone, with separate histories | Static web UI plus a reachable RSS acquisition API; each browser stores its own history | A reachable acquisition service is generally needed for arbitrary feeds. It can be self-hosted or serverless. |
| PC and smartphone with the same subscriptions, saved articles and history | Acquisition plus authenticated synchronization and durable shared storage | A shared service or platform sync is needed; it does not have to be a dedicated rented server. Not implemented here. |
| Future native PC/smartphone apps used on one device | Native networking and an on-device database can fetch and store feeds directly | No cloud backend is inherently required. Shared state and background behavior are separate design decisions. |

Browser JavaScript cannot read arbitrary feed responses unless the publisher permits the web origin through CORS.
Feeds that permit it can be fetched directly, and importing a feed file can work locally, but those do not cover general URL subscriptions.
See [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).
The proposed common boundary is an RSS acquisition API and an optional synchronization API, leaving the interface replaceable.

The local Node acquisition endpoint accepts only same-origin requests on loopback `127.0.0.1`; it is intentionally unavailable from a phone over the LAN.
Mobile viewport tests verify layout, not access from a physical phone or a deployed shared service.
A public deployment needs authentication, per-user limits, deployment-specific network controls and persistent storage design before exposure.
No Cloudflare/AWS service or LAN/public binding was enabled in this work.

## Acquisition boundary

Only public HTTPS destinations on the standard port are accepted; URL credentials and literal IP addresses are rejected.
In the local Node endpoint, DNS results must all be public addresses. The checked address is pinned to the TLS connection, while certificate validation uses the original hostname.
The authenticated Cloudflare endpoint uses the platform's strictly-public global fetch routing instead; see [the cloud acquisition boundary and deployment requirements](cloud-feed-collection.md).
Redirects are checked again, with at most three followed redirects. Requests have a 12-second total deadline and a 2 MB response limit.
RSS/Atom XML rejects DOCTYPE/entity declarations; discovery HTML can contain a normal HTML doctype and stays inert.
The local endpoint limits concurrent requests and body size, and does not forward cookies, authorization or arbitrary proxy options.
These controls do not make the local development endpoint ready for public deployment.
