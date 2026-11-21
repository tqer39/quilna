# Quick input and deeper reading

[English](product-experience.md) | [日本語](product-experience.ja.md)

## Audience and outcome

The owner's 2026-11-18 brief makes Quilna a place for busy people to combine quick information intake with deliberate, deeper understanding.
This is the current direction for [Issue #205](https://github.com/tqer39/quilna/issues/205) and the browser acceptance gate in [#41](https://github.com/tqer39/quilna/issues/41).
Existing screens and assets may be redesigned or rebuilt when that improves this outcome. Keep retained user data and source provenance; preserving an existing implementation is not a product requirement.

Textbook creation is currently administrator-only: the owner is the administrator of the personal deployment, and each OSS operator is their own administrator. Readers use prepared textbooks. Reader-authored textbooks may be offered when the product becomes a hosted Web service; they are not enabled now.

## Required experiences and evidence

| Experience | Required outcome | Current implementation and remaining evidence |
| --- | --- | --- |
| Collect while away | RSS and asynchronous collection deliver information without waiting on the reading screen. | On 2026-11-18 a local Worker fetched 20 Zenn RSS entries with Chrome shut down. Its queued feed survived a Worker restart. Reopening the reader delivered all 20 headlines and acknowledged the feed. In a separate run with no reader tabs open, the restarted Worker fetched the feed again 15 minutes after the first fetch. Collection in a hosted environment remains unverified. |
| Read now or later | Scan titles, save without opening, filter saved items and resume reading. | Readers can save an unread article directly from its row. At widths up to 800px, a populated library opens with the article list first. **絞り込み** leads to source and unread filters and selecting one returns focus to the results. Headlines wrap in full in one column at every width. Rows have a bookmark button and up to two lines of preview text. On desktop the first preview can use three lines. Select **見出し中心** beside the result count to hide previews and tags and show smaller thumbnails. The browser remembers this choice. An empty library shows the subscription form first. Owner usability acceptance remains open. |
| Understand a word quickly | Short definitions, synonyms, contrasts/antonyms, related words and external dictionary links keep reading lightweight. | A new dictionary dialog has a small edited technical vocabulary with source links. For uncatalogued words, readers can explicitly search Wikidata for candidates with Japanese descriptions and links to source items. |
| Discover current terminology | Use Google Trends, GitHub Trending, Hacker News and Reddit as distinct discovery sources. | The dictionary fetches Google Trends Japan RSS, Hacker News RSS and the GitHub daily Trending page on demand, retaining source-specific snapshots with timestamps and scope labels. Keywords or literal headline phrases lead to dictionary search. Reddit remains an external reference because its RSS service ended. Readers can enable periodic acquisition from one source while the reader is visible. Closed-browser trend collection, semantic ranking and owner acceptance remain open. |
| Learn deeply | Administrators create independent textbooks with an LLM asynchronously; readers reuse reviewed editions and resume private learning. | The OSS administrator prepares a prompt from selected excerpts and uses their own LLM to generate a draft and review it in a separate conversation. Quilna checks quotations against the excerpts and accepts a passing review before offering a textbook JSON file to preview, import or download. This [local workflow](topic-textbooks.md) requires no OpenAI API key. Browser regression tests use fixture responses. Local Ollama trials also verified import of model-generated editions, including one whose reviewer missed an omitted step. Teaching quality and owner usability acceptance remain open. Hosted generation is tracked separately in [#7](https://github.com/tqer39/quilna/issues/7) and [#202](https://github.com/tqer39/quilna/issues/202). |
| Keep personal context | Red-line highlights, notes, tags and bookmarks survive updates and navigation. | Saved passages have a red underline in the article, including inside inline code. Selecting a saved quote returns to that passage. Tags and bookmarks are available. Verify their usability, quote/version integrity and restored reading position across the new dictionary and textbook entry points. |
| Listen to relevant headlines | Narrow the news to the reader's interests and listen without opening or marking every article as read. | Listen to the current filtered page or save up to eight interests under **見出しを聞く → 関心のある未読記事**. The latter selects the newest 50 unread articles across sources with a matching title phrase or exact tag. Preview titles before listening and see the current title and its position during playback. Save the current headline for later while listening or paused. On 2026-11-18, local Chrome on macOS reported native start and completion for two titles using the Japanese Kyoko voice, pause, resume and interruption, with the unread count preserved. On 2026-11-20, Chrome 157.0.8103.79 on macOS played two fixture headlines with Kyoko. Saving the first during playback kept both unread, the second played to completion, and the saved list contained only the first after reload. Pronunciation quality and owner usability acceptance remain open. |
| Reuse collected information | Store shared information in a database and deliver reusable cached copies for anyone to consult. | The scoped catalog now has an opt-in [anonymous reader and revalidated JSON delivery](source-document-catalog.md#anonymous-reading-of-explicitly-published-copies) for explicitly published stored shared copies. Public delivery is not enabled in deployment configurations. Complete [#74](https://github.com/tqer39/quilna/issues/74), publication operations, provenance, source sharing policy and live multi-user verification. Keep personal bookmarks, highlights, subscriptions and answers private. |

These are all requirements of the product direction. Completing a dictionary or list slice does not complete the goal.
Do not publish existing private libraries or turn a retained personal copy into public content during a visual redesign.

## Discover words in current topics

Open **辞書 → 話題の言葉を探す** and choose an information source. Up to 20 entries retain that source's order; numbers and positions from different sources are not combined into a single popularity ranking.
Google Trends provides Japanese search keywords; a shared RSS link does not merge distinct keywords. Each shared feed link opens the keyword in Google Trends for Japan. When supplied by the feed, up to three related headlines can be expanded with their links and publishers. Hacker News provides headlines, and GitHub provides daily repository entries. Buttons for phrases use text actually present in each entry; they are not definitions, inferred relationships or generated summaries.
Selecting a phrase opens its dictionary entry. Within the open dictionary, a back button returns to the previous term or the entry list. Closing the dictionary clears this lookup history. Quilna checks headlines for catalogued phrases before filling the six term buttons with individual words. A headline containing “retrieval-augmented generation”, for example, links directly to the Japanese explanation of RAG, its source and related terms. Google Trends also keeps the full search phrase as the first button (up to 80 characters). For an uncatalogued term, choosing **Wikidataへ送って調べる** sends the displayed term to Wikidata. The dialog shows candidates with Japanese descriptions among the top three items and links to the corresponding source pages. Results are kept only in the current view.
Use **保存した教科書を探す** to search topic names, book titles and section headings in the current browser library. Select a matching section to start reading at its heading. Catalogued words also match their dictionary aliases. Matching editions open in another tab, preserving the original article and dictionary. In the OSS edition, if no matching book is found, **この言葉で教科書を作る** opens the local authoring form with the term filled in. You choose the source and excerpt.

Each snapshot displays its acquisition time and source scope. Source-provided dates remain separate; missing dates or RSS aggregation windows are not inferred. Store one current observation per source in the account-scoped browser database `quilna.trends.v1` and reuse observations younger than 15 minutes. Opening the section performs this cache check and refreshes older data asynchronously; **話題を更新** explicitly refreshes it sooner. Closing the dictionary cancels pending network requests; an already-started cache transaction may still commit. After 16 seconds from starting the cache check/refresh operation, an unconfirmed cache save is reported as awaiting confirmation rather than a failed write. A later confirmed save updates the current view, unless navigation or a newer request has superseded it. No subscription, read flag, bookmark or automatic collection schedule is changed by discovery.

Under **読書中に15分ごとに更新する情報源**, choose a source to refresh while the reader is visible and online, even with the dictionary closed. The setting defaults to off and is saved for the current library. Manual and automatic requests share a lock per source across tabs. Automatic checks reuse fresh snapshots and wait at least 15 minutes between attempts for that source, including after a fetch failure. Hiding or leaving the reader suspends the timer and cancels pending requests. Browsers without Web Locks offer manual refresh.
Failed refreshes retain the previous observation. Source changes discard late UI responses, and a transaction prevents an older observation from replacing a newer one saved by another tab. Unsupported or damaged stored data is not silently overwritten. If persistence fails, fresh results can be displayed with an explicit display-only notice. These replaceable snapshots are not part of reader-library backups or the shared server catalog; they can be acquired again.

On 2026-11-18, the local browser used the actual loopback acquisition server to obtain 10 Google Trends entries, 20 Hacker News headlines and 15 GitHub repositories and confirmed their retention after reload. This is dated local evidence, not production deployment or continuous collection verification. GitHub extraction depends on its public page structure; an empty or changed structure produces an explicit error and keeps prior data.
[Google documents RSS export](https://support.google.com/trends/answer/3076011?hl=en). [Reddit's official 2026-11-10 changelog](https://support.reddithelp.com/hc/en-us/articles/55472297340308-Changelog-November-10-2026) announces RSS retirement on 2026-11-13; its feed returned HTTP 404 in the local check. Reddit is not presented as connected, and no replacement API integration or paid service is enabled.

## Design approach

Use `frontend-design` to shape the reading experience and [Astryx Design Conventions](https://github.com/meta/astryx/wiki/Design-Conventions) to review hierarchy, spacing, role-based tokens, interaction states and accessibility.
This adopts design principles, not Astryx's React runtime or its complete component conventions.

- Studio palette: page `#f4f6f3`, surface `#ffffff`, main text `#182d29`, supporting text `#52645d`, action `#21685b`, boundary `#d5ddd7`. Editorial and Focus remain alternate reading treatments; their existence does not prevent later redesign.
- Typography: system sans-serif for navigation and scanning; the reading theme controls article typography. Distinguish titles, body and supporting information. Tune Japanese line length/leading with actual content rather than copying Latin-text measurements.
- Spacing: named 8/12/16/24/32px roles, grouped by relationship. Use shared control radius and at least 44px interaction targets in the new controls.
- States: save state uses text and `aria-pressed`; a pending write never appears successfully saved. Show unavailable voices and uncatalogued terms explicitly. Focus stays visible and the dictionary returns to the same reading context.
- Motion: user actions reveal controls; no decorative autoplay or newly introduced animation.

```text
Quilna     articles / saved / import     dictionary / textbooks / settings
sources    list title and short guidance
           headline player (optional)
           search and interest/tag filters
           title / source and state / excerpt / tags / save for later

article    content and source
           dictionary: brief meaning → related words → return to reading
           textbook: independent retained edition → deliberate learning
```

This first structure prioritizes real reading actions over a promotional landing page.
List rows show a short tag label; expand it to inspect publisher tags, automatic classification and personal tags separately.
Review desktop and 320px layouts, long Japanese titles, keyboard operation, visible focus, foreground/background contrast and reading restoration using screenshots and behavior tests.
Automated results do not establish owner usability acceptance, real audio quality, live trend ingestion, public cache delivery or actual LLM generation.
