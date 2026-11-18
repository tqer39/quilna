import Foundation
import XCTest
import CSQLite
@_spi(Testing) @testable import TextbookCore

@MainActor
final class FeedLibrarySearchTests: XCTestCase {
    func testLiteralNormalizationFieldsJapaneseAndShortTerms() async throws {
        let (directory, store, subscription) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let article = FeedArticle(
            id: "normalized", feedID: subscription.id, title: "Swift OR %*\"",
            url: URL(string: "https://search.example/normalized"), summary: "境界要約", content: "原文だけ 😀"
        )
        try await store.saveFetchedFeed(feed(subscription, [article]))
        let translation = ArticleTranslation(
            articleID: article.id, sourceFingerprint: article.sourceFingerprint, targetLanguage: "ja",
            title: "ガイド", body: "ひらがな カタカナ English"
        )
        try await store.saveTranslation(translation)

        for query in ["swift", "OR", "%*\"", "ｶﾞｲﾄﾞ", "がいど", "E", "En", "Eng", "😀"] {
            let page = try await store.searchArticles(ArticleSearchRequest(text: query))
            XCTAssertEqual(page.results.map(\.article.id), [article.id], query)
            XCTAssertEqual(page.results.first?.translation, translation, query)
            XCTAssertEqual(page.results.first?.isBookmarked, false, query)
        }
        try await store.setBookmarked(articleID: article.id, bookmarked: true)
        let savedPage = try await store.searchArticles(ArticleSearchRequest(text: "😀"))
        XCTAssertEqual(savedPage.results.first?.isBookmarked, true)
        let boundaryPage = try await store.searchArticles(ArticleSearchRequest(text: "文訳"))
        let andPage = try await store.searchArticles(ArticleSearchRequest(text: "swift カタカナ"))
        XCTAssertTrue(boundaryPage.results.isEmpty)
        XCTAssertEqual(andPage.results.map(\.article.id), [article.id])
    }

    func testPaginationFeedBookmarkFiltersAndNoCandidatePrelimit() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = try FeedSubscription(url: URL(string: "https://one.search.example/feed")!)
        let second = try FeedSubscription(url: URL(string: "https://two.search.example/feed")!)
        let store = try FeedLibraryStore(directory: directory)
        let firstArticles = (0 ..< 30).map {
            FeedArticle(id: "first-\($0)", feedID: first.id, title: "common needle \($0)", url: nil)
        }
        let secondArticles = (0 ..< 30).map {
            FeedArticle(id: "second-\($0)", feedID: second.id, title: "common needle \($0)", url: nil)
        }
        try await store.saveFetchedFeed(feed(first, firstArticles))
        try await store.saveFetchedFeed(feed(second, secondArticles))
        try await store.setBookmarked(articleID: "first-0", bookmarked: true)

        let firstPage = try await store.searchArticles(ArticleSearchRequest(text: "common needle", limit: 17))
        XCTAssertEqual(firstPage.results.count, 17)
        let cursor = try XCTUnwrap(firstPage.nextCursor)
        let secondPage = try await store.searchArticles(ArticleSearchRequest(text: "common needle", limit: 200, before: cursor))
        let overlap = Set(firstPage.results.map(\.article.id)).intersection(Set(secondPage.results.map(\.article.id)))
        XCTAssertEqual(overlap.count, 0)
        XCTAssertEqual(firstPage.results.count + secondPage.results.count, 60)
        let filtered = try await store.searchArticles(ArticleSearchRequest(text: "needle", feedID: first.id, limit: 200))
        let bookmarked = try await store.searchArticles(ArticleSearchRequest(text: "needle", bookmarksOnly: true))
        XCTAssertEqual(filtered.results.count, 30)
        XCTAssertEqual(bookmarked.results.map(\.article.id), ["first-0"])
    }

    func testValidationEmptyAndLimits() async throws {
        let (directory, store, subscription) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await store.saveFetchedFeed(feed(subscription, [
            FeedArticle(id: "bounds", feedID: subscription.id, title: "searchable", url: nil),
        ]))
        let empty = try await store.searchArticles(ArticleSearchRequest(text: "   "))
        let zero = try await store.searchArticles(ArticleSearchRequest(text: "searchable", limit: 0))
        XCTAssertTrue(empty.results.isEmpty)
        XCTAssertTrue(zero.results.isEmpty)
        await assertSearchError(.invalidQuery, store: store, text: "bad\u{0}")
        await assertSearchError(.queryTooLong, store: store, text: String(repeating: "a", count: 129))
        await assertSearchError(.tooManyTerms, store: store, text: "1 2 3 4 5 6 7 8 9")
    }

    func testSourceUpdateRemovesStaleJapaneseUntilFreshTranslationIsSaved() async throws {
        let (directory, store, subscription) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let old = FeedArticle(id: "changing", feedID: subscription.id, title: "Old source", url: nil, content: "old body")
        try await store.saveFetchedFeed(feed(subscription, [old]))
        try await store.saveTranslation(ArticleTranslation(
            articleID: old.id, sourceFingerprint: old.sourceFingerprint, targetLanguage: "ja",
            title: "古い翻訳", body: "消える日本語"
        ))
        let updated = FeedArticle(id: old.id, feedID: old.feedID, title: "New source", url: nil, content: "new body")
        try await store.saveFetchedFeed(feed(subscription, [updated]))
        let stalePage = try await store.searchArticles(ArticleSearchRequest(text: "消える日本語"))
        let updatedPage = try await store.searchArticles(ArticleSearchRequest(text: "New source"))
        XCTAssertTrue(stalePage.results.isEmpty)
        XCTAssertNil(updatedPage.results.first?.translation)
        let fresh = ArticleTranslation(
            articleID: updated.id, sourceFingerprint: updated.sourceFingerprint, targetLanguage: "ja",
            title: "新しい翻訳", body: "新鮮な日本語"
        )
        try await store.saveTranslation(fresh)
        let freshPage = try await store.searchArticles(ArticleSearchRequest(text: "新鮮な日本語"))
        XCTAssertEqual(freshPage.results.first?.translation, fresh)
    }

    func testBookmarkRetentionAndFinalRemoval() async throws {
        let (directory, store, subscription) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let article = FeedArticle(id: "retained", feedID: subscription.id, title: "offline searchable", url: nil)
        try await store.saveFetchedFeed(feed(subscription, [article]))
        try await store.setBookmarked(articleID: article.id, bookmarked: true)
        try await store.removeSubscription(id: subscription.id)
        let retained = try await store.searchArticles(ArticleSearchRequest(text: "offline"))
        XCTAssertEqual(retained.results.map(\.article.id), [article.id])
        try await store.setBookmarked(articleID: article.id, bookmarked: false)
        let removed = try await store.searchArticles(ArticleSearchRequest(text: "offline"))
        XCTAssertTrue(removed.results.isEmpty)

        let reopened = try FeedLibraryStore(directory: directory)
        let reopenedPage = try await reopened.searchArticles(ArticleSearchRequest(text: "offline"))
        XCTAssertTrue(reopenedPage.results.isEmpty)
    }

    func testLegacyV1BackfillKeepsStableDocumentIDAcrossReopenAndUpdate() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let databaseURL = directory.appendingPathComponent("feed-library.sqlite")
        let subscription = try FeedSubscription(url: URL(string: "https://legacy.search.example/feed")!)
        let raw = try SearchTestDatabase(url: databaseURL)
        try raw.execute("CREATE TABLE subscriptions(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT,etag TEXT,last_modified TEXT);CREATE TABLE articles(id TEXT PRIMARY KEY,feed_id TEXT NOT NULL,remote_id TEXT,title TEXT NOT NULL,url TEXT,summary TEXT NOT NULL,content TEXT NOT NULL,published REAL);CREATE TABLE bookmarks(article_id TEXT PRIMARY KEY REFERENCES articles(id));CREATE TABLE translations(article_id TEXT NOT NULL REFERENCES articles(id),source_fingerprint TEXT NOT NULL,target_language TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(article_id,target_language));PRAGMA user_version=1")
        try raw.execute("INSERT INTO subscriptions(id,url,title) VALUES('\(subscription.id)','https://legacy.search.example/feed','Legacy')")
        try raw.execute("INSERT INTO articles(id,feed_id,title,summary,content) VALUES('legacy','\(subscription.id)','legacy searchable','','')")

        let store = try FeedLibraryStore(directory: directory)
        let backfilled = try await store.searchArticles(ArticleSearchRequest(text: "legacy searchable"))
        XCTAssertEqual(backfilled.results.map(\.article.id), ["legacy"])
        let firstDocumentID = try raw.scalar("SELECT document_id FROM article_search_documents WHERE article_id='legacy'")
        let updated = FeedArticle(id: "legacy", feedID: subscription.id, title: "updated searchable", url: nil)
        try await store.saveFetchedFeed(feed(subscription, [updated]))
        let reopened = try FeedLibraryStore(directory: directory)
        let reopenedPage = try await reopened.searchArticles(ArticleSearchRequest(text: "updated searchable"))
        let secondDocumentID = try raw.scalar("SELECT document_id FROM article_search_documents WHERE article_id='legacy'")
        XCTAssertEqual(reopenedPage.results.map(\.article.id), ["legacy"])
        XCTAssertEqual(secondDocumentID, firstDocumentID)
        XCTAssertEqual(try raw.scalar("PRAGMA user_version"), 1)
    }

    func testRawSourceMutationInvalidatesIndex() async throws {
        let (directory, store, subscription) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let article = FeedArticle(id: "raw", feedID: subscription.id, title: "indexed original", url: nil)
        try await store.saveFetchedFeed(feed(subscription, [article]))
        let raw = try SearchTestDatabase(url: directory.appendingPathComponent("feed-library.sqlite"))
        try raw.execute("UPDATE articles SET title='raw replacement' WHERE id='raw'")
        let oldPage = try await store.searchArticles(ArticleSearchRequest(text: "indexed original"))
        let rawPage = try await store.searchArticles(ArticleSearchRequest(text: "raw replacement"))
        XCTAssertTrue(oldPage.results.isEmpty)
        XCTAssertTrue(rawPage.results.isEmpty)
    }

    func testRawTranslationMutationInvalidatesWithoutConnectionLocalFunctions() async throws {
        let (directory, store, subscription) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let article = FeedArticle(id: "raw-translation", feedID: subscription.id, title: "safe original", url: nil)
        try await store.saveFetchedFeed(feed(subscription, [article]))
        let raw = try SearchTestDatabase(url: directory.appendingPathComponent("feed-library.sqlite"))
        try raw.execute("INSERT INTO translations(article_id,source_fingerprint,target_language,title,body) VALUES('raw-translation','\(article.sourceFingerprint)','ja','raw japanese','raw body')")
        let originalPage = try await store.searchArticles(ArticleSearchRequest(text: "safe original"))
        let japanesePage = try await store.searchArticles(ArticleSearchRequest(text: "raw japanese"))
        XCTAssertTrue(originalPage.results.isEmpty)
        XCTAssertTrue(japanesePage.results.isEmpty)
    }

    func testUnknownReservedSearchSchemaIsRefusedWithoutMutation() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let databaseURL = directory.appendingPathComponent("feed-library.sqlite")
        let raw = try SearchTestDatabase(url: databaseURL)
        try raw.execute("CREATE TABLE subscriptions(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT,etag TEXT,last_modified TEXT);CREATE TABLE articles(id TEXT PRIMARY KEY,feed_id TEXT NOT NULL,remote_id TEXT,title TEXT NOT NULL,url TEXT,summary TEXT NOT NULL,content TEXT NOT NULL,published REAL);CREATE TABLE bookmarks(article_id TEXT PRIMARY KEY REFERENCES articles(id));CREATE TABLE translations(article_id TEXT NOT NULL REFERENCES articles(id),source_fingerprint TEXT NOT NULL,target_language TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(article_id,target_language));CREATE TABLE article_search_unknown(value TEXT);PRAGMA user_version=1")
        let before = try Data(contentsOf: databaseURL)
        XCTAssertThrowsError(try FeedLibraryStore(directory: directory))
        let after = try Data(contentsOf: databaseURL)
        XCTAssertEqual(after, before)
    }

    func testModifiedKnownSearchTriggerIsRefusedWithoutRepair() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try FeedLibraryStore(directory: directory)
        let raw = try SearchTestDatabase(url: directory.appendingPathComponent("feed-library.sqlite"))
        try raw.execute("""
            DROP TRIGGER article_search_article_update;
            CREATE TRIGGER article_search_article_update AFTER UPDATE ON articles
            WHEN NEW.id<>OLD.id BEGIN
              DELETE FROM article_search_fts WHERE rowid=(SELECT document_id FROM article_search_documents WHERE article_id=OLD.id AND indexed_source_fingerprint IS NOT NULL);
              UPDATE article_search_documents SET feed_id=NEW.feed_id,indexed_source_fingerprint=NULL WHERE article_id=OLD.id AND NEW.id=OLD.id;
              DELETE FROM article_search_documents WHERE article_id=OLD.id AND NEW.id<>OLD.id;
            END;
            """)
        let tamperedDefinition = try raw.text("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='article_search_article_update'")

        XCTAssertThrowsError(try FeedLibraryStore(directory: directory)) { error in
            XCTAssertEqual(error as? FeedError, .corrupted)
        }
        XCTAssertEqual(
            try raw.text("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='article_search_article_update'"),
            tamperedDefinition
        )
    }

    func testNonisolatedReaderSeesCommittedSnapshotsAcrossBeforeCommitGate() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = SearchCommitGate()
        let store = try FeedLibraryStore(directory: directory, beforeCommit: { gate.pause() })
        let subscription = try FeedSubscription(url: URL(string: "https://search.example/feed")!)
        let old = FeedArticle(id: "gated", feedID: subscription.id, title: "old committed", url: nil)
        gate.enabled = false
        try await store.saveFetchedFeed(feed(subscription, [old]))
        gate.enabled = true
        let updated = FeedArticle(id: old.id, feedID: old.feedID, title: "new pending", url: nil)
        let saving = Task { try await store.saveFetchedFeed(self.feed(subscription, [updated])) }
        await fulfillment(of: [gate.entered], timeout: 5)

        let oldPage = try await store.searchArticles(ArticleSearchRequest(text: "old committed"))
        let pendingPage = try await store.searchArticles(ArticleSearchRequest(text: "new pending"))
        XCTAssertEqual(oldPage.results.map(\.article.id), [old.id])
        XCTAssertTrue(pendingPage.results.isEmpty)
        gate.release()
        try await saving.value
        let newPage = try await store.searchArticles(ArticleSearchRequest(text: "new pending"))
        XCTAssertEqual(newPage.results.map(\.article.id), [old.id])
    }

    private func assertSearchError(_ expected: ArticleSearchError, store: FeedLibraryStore, text: String) async {
        do {
            _ = try await store.searchArticles(ArticleSearchRequest(text: text))
            XCTFail("Expected \(expected)")
        } catch { XCTAssertEqual(error as? ArticleSearchError, expected) }
    }

    func testDeferredBackfillAllowsReadsSavesAndResumesWithoutPartialSearch() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let raw = try SearchTestDatabase(url: directory.appendingPathComponent("feed-library.sqlite"))
        try raw.execute("CREATE TABLE subscriptions(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT,etag TEXT,last_modified TEXT);CREATE TABLE articles(id TEXT PRIMARY KEY,feed_id TEXT NOT NULL,remote_id TEXT,title TEXT NOT NULL,url TEXT,summary TEXT NOT NULL,content TEXT NOT NULL,published REAL);CREATE TABLE bookmarks(article_id TEXT PRIMARY KEY REFERENCES articles(id));CREATE TABLE translations(article_id TEXT NOT NULL REFERENCES articles(id),source_fingerprint TEXT NOT NULL,target_language TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(article_id,target_language));PRAGMA user_version=1")
        let subscription = try FeedSubscription(url: URL(string: "https://prepare.example/feed")!)
        try raw.execute("INSERT INTO subscriptions(id,url,title) VALUES('\(subscription.id)','https://prepare.example/feed','Preparation')")
        for index in 0 ..< 40 {
            try raw.execute("INSERT INTO articles(id,feed_id,title,summary,content) VALUES('item-\(index)','\(subscription.id)','needle \(index)','','body')")
        }
        var store: FeedLibraryStore? = try FeedLibraryStore(directory: directory, deferSearchPreparation: true)
        let cache = try await store!.articles(limit: 100)
        XCTAssertEqual(cache.count, 40)
        await assertSearchError(.notReady, store: store!, text: "needle")
        let progress = try await store!.prepareSearchBatch()
        guard case .preparing(let count) = progress else { return XCTFail("backfill completed in one batch") }
        XCTAssertGreaterThan(count, 0)
        XCTAssertLessThan(count, 40)
        await assertSearchError(.notReady, store: store!, text: "needle")

        // Both writes finish with most of the initial corpus still unindexed.
        let article = try XCTUnwrap(cache.first)
        try await store!.setBookmarked(articleID: article.id, bookmarked: true)
        let translation = ArticleTranslation(articleID: article.id, sourceFingerprint: article.sourceFingerprint,
                                             targetLanguage: "ja", title: "保存済み", body: "再開しても検索可能")
        try await store!.saveTranslation(translation)
        let newArticle = FeedArticle(id: "new", feedID: subscription.id, title: "needle added", url: nil)
        try await store!.saveFetchedFeed(feed(subscription, [newArticle]))
        XCTAssertEqual(try raw.scalar("SELECT count(*) FROM bookmarks"), 1)
        store = nil

        let reopened = try FeedLibraryStore(directory: directory, deferSearchPreparation: true)
        let resumedProgress = try await reopened.searchPreparationStatus()
        XCTAssertEqual(resumedProgress, progress)
        // A second scene can help: both use the durable cursor under a write lock.
        let otherScene = try FeedLibraryStore(directory: directory, deferSearchPreparation: true)
        try await withThrowingTaskGroup(of: Bool.self) { group in
            for active in [reopened, otherScene] {
                group.addTask {
                    for _ in 0 ..< 100 {
                        if try await active.prepareSearchBatch().isReady { return true }
                        await Task.yield()
                    }
                    return false
                }
            }
            for try await completed in group { XCTAssertTrue(completed) }
        }
        let page = try await reopened.searchArticles(ArticleSearchRequest(text: "needle", limit: 100))
        XCTAssertEqual(Set(page.results.map(\.article.id)), Set((0 ..< 40).map { "item-\($0)" } + ["new"]))
        let japanese = try await otherScene.searchArticles(ArticleSearchRequest(text: "再開しても検索可能"))
        XCTAssertEqual(japanese.results.first?.translation, translation)
        XCTAssertEqual(japanese.results.first?.isBookmarked, true)
        XCTAssertEqual(try raw.scalar("SELECT count(*) FROM sqlite_master WHERE name='article_search_preparation'"), 0)
    }

    func testCancelledPreparationDoesNotAdvanceDurableCursor() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try FeedLibraryStore(directory: directory, deferSearchPreparation: true)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await store.prepareSearchBatch()
        }
        do { _ = try await task.value; XCTFail("cancelled batch completed") }
        catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        let progress = try await store.searchPreparationStatus()
        XCTAssertEqual(progress, .preparing(processedArticles: 0))
        let completed = try await store.prepareSearchBatch()
        XCTAssertEqual(completed, .ready)
    }

    func testUnknownPreparationMarkerIsRejectedWithoutMutation() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try FeedLibraryStore(directory: directory)
        let raw = try SearchTestDatabase(url: directory.appendingPathComponent("feed-library.sqlite"))
        try raw.execute("CREATE TABLE article_search_preparation(future TEXT); INSERT INTO article_search_preparation VALUES('preserve')")
        XCTAssertThrowsError(try FeedLibraryStore(directory: directory, deferSearchPreparation: true))
        XCTAssertEqual(try raw.text("SELECT future FROM article_search_preparation"), "preserve")
    }

    private func makeStore() throws -> (URL, FeedLibraryStore, FeedSubscription) {
        let directory = temporaryDirectory()
        let subscription = try FeedSubscription(url: URL(string: "https://search.example/feed")!)
        return (directory, try FeedLibraryStore(directory: directory), subscription)
    }

    private func feed(_ subscription: FeedSubscription, _ articles: [FeedArticle]) -> ParsedFeed {
        ParsedFeed(id: subscription.id, sourceURL: subscription.url, title: "Search", articles: articles)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }
}

private final class SearchCommitGate: @unchecked Sendable {
    let entered = XCTestExpectation(description: "writer reached beforeCommit")
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var isEnabled = true
    var enabled: Bool {
        get { lock.withLock { isEnabled } }
        set { lock.withLock { isEnabled = newValue } }
    }
    func pause() {
        guard enabled else { return }
        entered.fulfill()
        _ = semaphore.wait(timeout: .now() + 10)
    }
    func release() { semaphore.signal() }
}

private final class SearchTestDatabase {
    private let db: OpaquePointer
    init(url: URL) throws {
        var opened: OpaquePointer?
        guard sqlite3_open(url.path, &opened) == SQLITE_OK, let opened else { throw FeedError.unavailable }
        db = opened
    }
    deinit { sqlite3_close(db) }
    func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw FeedError.unavailable }
    }
    func scalar(_ sql: String) throws -> Int64 {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw FeedError.unavailable
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, sqlite3_column_type(statement, 0) == SQLITE_INTEGER else {
            throw FeedError.unavailable
        }
        return sqlite3_column_int64(statement, 0)
    }
    func text(_ sql: String) throws -> String {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw FeedError.unavailable
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, sqlite3_column_type(statement, 0) == SQLITE_TEXT,
              let bytes = sqlite3_column_text(statement, 0) else {
            throw FeedError.unavailable
        }
        return String(cString: bytes)
    }
}
