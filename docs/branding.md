# Quilna naming and domain decision

[English](branding.md) | [日本語](branding.ja.md)

## Decision and product intent

On 2026-10-24, the project owner chose **Quilna**, written **クイルナ** in Japanese, and **quilna.page** as the canonical domain.
The product helps people gather information, select what matters, think, and compile their own textbooks to deepen their understanding.
Human selection and reasoning are central; the name should accommodate more than reading, collecting links, or receiving generated summaries.

The naming discussion sought a distinctive sound, a natural four-character Japanese reading, and reasonably predictable English pronunciation.
Familiar words, blended words, and meaningful initialisms were acceptable.
`learn`, `-ist`/`-nist`, `-ism`, and a meaningful top-level domain were considered optional building blocks.
`learn` was explicitly removed as a requirement so it would not constrain the sound or distinctiveness.
Unpleasant Japanese/English associations and overlap with existing services also mattered.

## Options considered

| Direction | Examples discussed | Outcome |
| --- | --- | --- |
| Previous name | TsumikiText / 積み木テキスト | Required an explanation of the Japanese building-block metaphor for an English-speaking audience. |
| Descriptive phrases | Read & Reason, Curiosity Shelf, Study Folio | Early options; the discussion subsequently favored a shorter coined name and the broader human-led textbook workflow. |
| Writing/crafting metaphor | Textsmith | The owner liked the direction; the final selection was Quilna. |
| Learning-related blends and suffixes | Lerismo, Lerista, `learn`, `-ist`/`-ism` | Explored pronunciation and associations; using `learn` became optional. |
| Final selection | Quilna / クイルナ; quilna.page | Chosen by the owner after discussion of pronunciation, domain availability, and potentially similar trademarks. |

Quilna was discussed as a coined name evoking **quill**, the writing instrument.
The Japanese form is ク・イ・ル・ナ: four written katakana characters.
The proposed English reading is **KWIL-nuh**, approximately `/ˈkwɪlnə/`.
That is a spelling-based proposal, not an established dictionary pronunciation or the result of a native-speaker study.
Alternative readings remain possible, including Japanese キルナ; the chosen reading should be presented consistently.
The `.page` ending supports the textbook/page association without forcing an educational word into the service name.

## Research snapshot: 2026-10-24

This section records the earlier investigation and discussion, not a fresh availability check or a legal clearance opinion.
Search results, prices, registration status, and store listings can change.

| Area | Observation and scope |
| --- | --- |
| Domain | The Google Registry RDAP lookup for `quilna.page` returned 404, and Porkbun showed it available to add to the cart without a premium label. No purchase was made. |
| Price | Porkbun displayed **US$10.81 for registration and renewal per year**. This was a research snapshot, not a checkout quote; recheck availability, renewal terms, taxes, and fees before purchasing. |
| Exact trademark searches | No exact Quilna result was found in the Japanese, US, and EU searches performed. This does not establish worldwide availability or exclude similar marks. |
| Services and stores | No exact-name app was found in the Japanese/US App Store API searches performed. Google Play checks used search-engine indexing; store countries and unindexed listings were not exhaustively covered. |
| Meanings and associations | No obvious derogatory English meaning was identified in the checks performed. This was not a comprehensive language review or proof that no existing use or association exists. |

Domain references: [registry RDAP endpoint](https://pubapi.registry.google/rdap/domain/quilna.page) and [Porkbun .page pricing](https://porkbun.com/tld/page).
The RDAP endpoint may now return a different result, or 404 while the name remains unregistered.

## Similar trademarks and the adoption judgment

| Mark | Record and actual-use evidence | Comparison discussed |
| --- | --- | --- |
| Kirune | Japan registration **6681062**, Techno-Speech. The official product is the singing voice library/character **機流音（きるね）**. Recorded pronunciations include キルネ and キルーン. | `QUILNA` and `KIRUNE` differ visually, and クイルナ differs from キルネ in both the beginning and ending. Singing synthesis and compiling textbooks have different purposes, but the registration also covers broad software, electronic publications, and related services. |
| KIRUNA | EU trademark **018736632**, SENER, INGENIERIA Y SISTEMAS, S.A., classes 9 and 42. The registered list includes downloadable software, content/data management software, and electronic publications. Its specific current product use was not confirmed in this investigation. | `QUILNA` and `KIRUNA` have different beginnings but share the ending `NA`. Japanese クイルナ and キルナ are closer in sound; a キルナ reading of Quilna would reduce the distinction. The proposed English `/kwɪl…/` also differs from the dictionary reading of the place name Kiruna. |

Sources: [Kirune registration](https://www.j-platpat.inpit.go.jp/c1801/TR/JP-2022-111541/40/ja), [official Kirune product](https://www.voisona.com/song/artist/kirune_ja_JP/), [KIRUNA EU registration](https://euipo.europa.eu/eSearch/#details/trademarks/018736632), and [Kiruna dictionary entry](https://www.collinsdictionary.com/dictionary/english/kiruna).

The discussion distinguished similarity of the names from similarity of the registered goods/services.
Different spellings and actual purposes support differentiation, but do not by themselves establish that the marks are legally unrelated.
The broad registered wording can overlap even when the products currently sold have different purposes.
Japan and the EU also require separate territorial assessments; the intended Japanese reading does not determine how EU consumers read the mark.
See the [JPO examination criteria](https://www.jpo.go.jp/system/laws/rule/guideline/trademark/kijun/document/index/20_4-1-11.pdf).

After reviewing those distinctions, the owner explicitly decided to adopt Quilna as the service name and quilna.page as the canonical domain.
Record this as the **project's adoption decision**, with the research scope above, rather than a guarantee of registration or non-infringement.
An automated similar-pronunciation search hit alone was not treated as a legal finding of similarity.

## Implemented rename and compatibility

- [Quilna PR #52](https://github.com/tqer39/quilna/pull/52) updated web/login branding, npm metadata, Apple app/build names, CI references, configuration examples, and paired documentation.
- [terraform-github PR #1812](https://github.com/tqer39/terraform-github/pull/1812) renamed the existing GitHub repository and set its homepage to `https://quilna.page`; its numeric repository ID remained unchanged.
- [terraform-github PR #1813](https://github.com/tqer39/terraform-github/pull/1813) moved the Terraform root to `terraform/src/repositories/quilna`. The backend key `terraform-github/repositories/adaptive-textbook.tfstate` was retained; CI confirmed no infrastructure changes for that move.

Legacy Application Support directories, bundle IDs, browser-storage/encryption identifiers, and existing Worker/D1 names were retained to preserve data and resource identity.
They are compatibility identifiers, not alternative public service names.
Historical publication records retain the old address as dated evidence.
The rename passed local validation and the post-merge main CI; it did not redeploy the hosted Dev site.

## Deferred operational work

[Issue #53](https://github.com/tqer39/quilna/issues/53) tracks domain purchase, DNS/HTTPS connection, existing-resource checks, Dev redeployment, origin/OAuth alignment, verification, and rollback.
Those operations were not performed as part of the rename or this decision record.
Use the [Dev publication record](dev-publication.md) and [owner-only setup guide](owner-only-setup.md) for the existing deployment and configuration boundaries.
