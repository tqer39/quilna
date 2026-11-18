# Quick input and deeper reading

[English](product-experience.md) | [日本語](product-experience.ja.md)

## Audience and outcome

The owner's 2026-11-18 brief makes Quilna a place for busy people to combine quick information intake with deliberate, deeper understanding.
This is the current direction for [Issue #205](https://github.com/tqer39/quilna/issues/205) and the browser acceptance gate in [#41](https://github.com/tqer39/quilna/issues/41).
Existing screens and assets may be redesigned or rebuilt when that improves this outcome. Keep retained user data and source provenance; preserving an existing implementation is not a product requirement.

## Required experiences and evidence

| Experience | Required outcome | Current implementation and remaining evidence |
| --- | --- | --- |
| Collect while away | RSS and asynchronous collection deliver information without waiting on the reading screen. | Browser collection and an owner-bound cloud queue exist. Verify live continuous collection and the redesigned collection flow; source-specific adapters remain explicit. |
| Read now or later | Scan titles, save without opening, filter saved items and resume reading. | A direct **あとで読む** action is added to each list row. Existing IndexedDB saved/read state and reader position remain authoritative. New browser regressions and owner acceptance are required. |
| Understand a word quickly | Short definitions, synonyms, contrasts/antonyms, related words and external dictionary links keep reading lightweight. | A new dictionary dialog has a small edited technical vocabulary with source links. Unknown words lead to external search; it is not a general live dictionary or LLM generation. Broader vocabulary and current-word acquisition remain open. |
| Discover current terminology | Use Google Trends, GitHub Trending, Hacker News and Reddit as distinct discovery sources. | The dictionary fetches Google Trends Japan RSS, Hacker News RSS and the GitHub daily Trending page on demand, retaining source-specific snapshots with timestamps and scope labels. Keywords or literal headline phrases lead to dictionary search. Reddit remains an external reference because its RSS service ended. Background trend ingestion, semantic ranking and owner acceptance remain incomplete. |
| Learn deeply | Create independent textbooks with an LLM asynchronously, retain reviewed editions, reuse them and resume private learning. | Existing file import/reading and generation infrastructure are separate from a verified live-generation experience. Complete [#7](https://github.com/tqer39/quilna/issues/7) and [#202](https://github.com/tqer39/quilna/issues/202), including actual provider setup, budgets, durable jobs, evidence/quality and failure recovery. |
| Keep personal context | Red-line highlights, notes, tags and bookmarks survive updates and navigation. | Highlights, tags and bookmarks exist. Verify their usability, quote/version integrity and restored reading position across the new dictionary and textbook entry points. |
| Listen to relevant headlines | Narrow the news to the reader's interests and listen without opening or marking every article as read. | A new local-voice player uses the current search/source/tag-filtered page, up to 50 titles, with language, voice, speed, pause and stop controls. It reads titles, not generated summaries. Verify queue cancellation, saved/read preservation and actual audio quality. Persistent interest profiles and an independently curated digest remain open. |
| Reuse collected information | Store shared information in a database and deliver reusable cached copies for anyone to consult. | The scoped catalog now has an opt-in [anonymous reader and revalidated JSON delivery](source-document-catalog.md#anonymous-reading-of-explicitly-published-copies) for explicitly published stored shared copies. Public delivery is not enabled in deployment configurations. Complete [#74](https://github.com/tqer39/quilna/issues/74), publication operations, provenance, source sharing policy and live multi-user verification. Keep personal bookmarks, highlights, subscriptions and answers private. |

These are all requirements of the product direction. Completing a dictionary or list slice does not complete the goal.
Do not publish existing private libraries or turn a retained personal copy into public content during a visual redesign.

## Discover words in current topics

Open **辞書 → 話題の言葉を探す** and choose an information source. Up to 20 entries retain that source's order; numbers and positions from different sources are not combined into a single popularity ranking.
Google Trends provides Japanese search keywords; a shared RSS link does not merge distinct keywords. Hacker News provides headlines, and GitHub provides daily repository entries. Buttons for phrases use text actually present in each entry; they are not definitions, inferred relationships or generated summaries.
Selecting a phrase fills the dictionary. Unknown terms remain explicitly uncatalogued and can be searched in an external dictionary.

Each snapshot displays its acquisition time and source scope. Source-provided dates remain separate; missing dates or RSS aggregation windows are not inferred. Store one current observation per source in the account-scoped browser database `quilna.trends.v1` and reuse observations younger than 15 minutes. Opening the section performs this cache check and refreshes older data asynchronously; **話題を更新** explicitly refreshes it sooner. Closing the dictionary cancels pending requests. No subscription, read flag, bookmark or automatic collection schedule is changed by discovery.
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
