# Quilna

[English](README.md) | [日本語](README.ja.md)

Quilna (クイルナ) helps people select information, think, and compile their own textbooks.
The repository name is `quilna`; the canonical domain is [quilna.page](https://quilna.page).
Domain registration, DNS connection, and production publication are not part of this rename.
The current app and sample lessons are in Japanese.
See the [naming and domain decision](docs/branding.md) for the research scope and adoption judgment; [Issue #53](https://github.com/tqer39/quilna/issues/53) tracks domain registration, DNS connection, and Dev redeployment.

Complete all agreed product features in the browser and obtain explicit owner usability acceptance before advancing to iOS/macOS, one platform at a time.
Native feature development is on hold; see the [development sequence and acceptance gate](docs/product-development.md).

The minimal SwiftUI apps for macOS and iOS are in `apple/`; the Go development harness is in `harness/`.
The native app supports RSS/Atom feeds, bookmarks, Apple's on-device translation, and fixed Japanese lessons with comprehension questions and answer history.
Articles, Japanese translations, bookmarks, and answer history are stored in SQLite. LLM-powered lesson generation and cross-device sync are not connected.
See the [native app and harness guide](docs/native-harness.md) and [tool/SaaS evaluation](docs/harness-tools.md).
The development harness has been verified with live Codex implementation, review, and repair using the existing Pro login.
See the [live validation results and reproduction steps](docs/codex-live-validation.md). This connection is separate from the product's lesson generation.
The browser starts with site/article URL discovery, RSS/Atom registration, refresh, article reading and local saving.
See [startup, storage scope and backend choices by interface](docs/browser-rss.md).
The lesson features below remain available through **設定 → デモ教材 → デモ教材を開く**.

An owner-only development site was published under the previous name; Google authentication setup is pending.
See the [existing deployment record](docs/dev-publication.md).
Purchasing a production domain, publishing to production, and sending live LLM requests are outside this work.
See the [minimum setup before publication](docs/workers-byok.md).

This textbook prototype lets busy SREs read, interact with diagrams, predict outcomes, answer questions, and practice explanations.
It contains one fixed CAA lesson section. Version 1.8.0 has 13 short blocks and takes about 25–35 minutes, with optional diagram predictions and reflection.
Lesson generation, live Google integration, and cloud sync are not implemented.
The "Your API key settings" screen simulates OpenAI/Anthropic BYOK management. Entry of real keys is disabled.
Simulated settings stay in memory; no live API is connected. See the [storage design and prerequisites](docs/byok.md).
Encrypted Workers storage, user APIs, per-user budgets, and Google login/session/logout code are implemented locally.
Authentication has been replaced with Better Auth 1.7.7 and a dedicated D1 database. See the [configuration and validation scope](docs/better-auth.md).
The Google settings screen uses the real API routes, which stop when configuration is missing. Entry and submission of real keys remain disabled.
Use `npm run workers:local` to try Workers hosting with provider communication disabled. See [details and remaining connections](docs/workers-byok.md).

## Run locally

Use the patched Node.js 26.12.1 configured in `mise.toml`, with npm.
`package.json` also declares security minimums for maintained 22/24 release lines; CI uses 26.12.1.
The steps are the same on macOS, Windows, and Linux.

```bash
mise install node
mise exec -- npm ci
mise exec -- npm run dev
```

Open <http://127.0.0.1:5173> in a browser.
RSS refresh connects from the local acquisition process to the registered public HTTPS publisher.
RSS articles and subscriptions use this browser's IndexedDB, without device synchronization.
No AI API, real account connection or new cloud deployment is enabled.
The following keyboard controls and answer history belong to the demo lesson in Settings.
Press N for the next block and P for the previous block; uppercase also works. These shortcuts are inactive in inputs and term dialogs.
The "N: next / P: previous" checkbox disables single-character shortcuts. If saving the setting fails, it applies only to the current tab.
History is stored in this browser's localStorage.
It is not shared across ports or browsers and is lost when browser data is deleted.

## Keep running on Mac Studio after the chat ends

Run these commands in the repository directory using the existing tmux installation.
Do not create a duplicate session if it is already running.

```bash
tmux new-session -d -s adaptive-textbook-caa 'npm run dev -- --strictPort'
tmux capture-pane -p -t adaptive-textbook-caa
```

The server runs in detached tmux, independently of the chat's terminal session.
It remains available until the Mac restarts, tmux exits, or the server stops.
Automatic startup is not configured. A port conflict stops startup rather than selecting another port.

`http://127.0.0.1:5173/` is accessible only on the Mac Studio running the server.
Localhost on another Mac or iPhone refers to that device itself.
This localhost server is not exposed to external networks. Authentication setup for the separately published development site is pending.

To stop it, target only this session:

```bash
tmux kill-session -t adaptive-textbook-caa
```

## Validation

TypeScript remains the browser implementation language. An optional Rust compiler check is available with `mise run typecheck:tsrs`; see [the local trial and compatibility limits](docs/typescript-tools.md).

The [security maintenance guide](docs/security-maintenance.md) covers Renovate, full dependency audits, runtime/certificate updates, and daily checks.
Installation scripts are disabled by the project `.npmrc`; explicitly requested npm commands still run.

```bash
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`mise run lint` runs the same lint checks, including documentation pairs and local Markdown links.
Only the initial dependency and Chromium downloads require network access.
Screenshots are saved in `test-results/`.
Desktop and mobile viewports are tested in Chromium on Mac Studio.
Windows, Linux, and physical smartphones have not been tested yet.

## Implementation boundaries

- `src/schema.ts` / `src/book.ts`: Zod-validated lessons and stable block IDs.
- `src/ui.ts`: shared UI and restricted Markdown: paragraphs, bold, and inline code.
- `src/renderer.ts`: reading and question renderers selected by type.
- `src/process-diagrams.ts`: the pre-issuance sequence and a step-by-step lookup flow.
- `src/caa.ts` / `src/diagram.ts` / `src/scope-diagram.ts`: shared semantics and SVG diagrams.
- `src/resume-review.ts`: an optional review question, with recall separated from self-reported confidence.
- `src/improvements.ts` / `src/question-workbench.ts`: questions, evidence, manual diffs, owner-applied edits, and local versioning.
- `src/history.ts`: separate fields for answer history and reading position.
- `src/main.ts`: contents, time estimates, and navigation.
- `src/navigation-shortcuts.ts`: optional N/P navigation, excluding inputs, modals, and IME composition.
- `src/terms.ts`: static, context-specific term explanations.
- `src/feedback.ts`: distinct states for answer correctness, save results, and notices.
- `src/diagram-exercise.ts` / `src/diagram-learning.ts`: predictions, configuration snapshots, comparison, and reflection.
- `src/question-support.ts`: choice-specific misconceptions and reasoning checks.
- `src/reader-dialog.ts`: explanation dialogs that preserve reading position, with Back/Forward navigation.
- `src/learning-plan.ts`: editorial time estimates and stopping points for each block.
- `src/mobile-dns-tree.ts`: a mobile DNS tree that does not shrink its text.

HTML is treated as text. Arbitrary JavaScript, MDX, and generated code are not executed.
Records include the lesson ID/version, local anonymous user ID, block ID, attempt ID, and timestamp.
If saving fails, answers remain in the tab and a retry action is shown.
Corrupted saved data is not overwritten automatically.

See the [design, issues, and validation log](docs/prototype.md).

The [design for growing lessons from questions and terms](docs/growing-textbook.md) is also documented.
Static term explanations are available; generating lessons from future conversations and questions is not implemented.

## Test with the installed Chrome

```bash
npx playwright test --config=playwright.chrome.config.ts
```

Chromium and Chrome each use two workers with independent BrowserContexts.
Images are separated by test, project, repeat, and retry; the two runners also have separate output directories.
Traces are saved on failure. See the [investigation log](docs/browser-timeout-investigation.md) for the initially unexplained timeout.

See the [generation API connection decision and ¥500 limit](docs/generation-connection.md).
Questions and manual diffs can be saved and applied locally; AI generation is not connected.

## Optional server with provider communication disabled

```bash
npm run server:off
```

The server binds only to 127.0.0.1:5274. Even requests with a valid Host, Origin, and CSRF token receive a response stating that generation is not connected.
The reading UI does not connect to this server. It does not send provider requests, incur provider charges, or configure keys.
`server/` separates a task-specific model registry, a thin adapter boundary, and a persistent budget reservation ledger shared by all providers.
OpenAI/Anthropic counting and generation HTTP code is prepared, but tested only with network mocks and not registered during normal startup.
No live API submissions, key setup, or charges have been made. See the [connection decision](docs/generation-connection.md) for candidates and remaining prerequisites.
`.local-state/` is ignored by Git. The ¥500 monthly real-cost target has not been verified; execution stops if cost conditions are missing.
The backend uses only Node standard modules and Zod. Stubs exist only in tests.
`npm test` runs lesson tests with Vitest and backend tests with Node's test runner; HTTP tests use temporary localhost ports.

## Documentation

English documentation uses `.md`; Japanese translations use `.ja.md`. Each page links to its counterpart.
See [AGENTS.md](AGENTS.md) for contributor instructions and the [documentation rules](docs/rules/documentation.md) for scoped updates that avoid retranslating unrelated pages.
