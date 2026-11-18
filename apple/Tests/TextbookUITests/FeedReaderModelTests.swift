import Foundation
import XCTest
import TextbookCore
@testable import TextbookUI

@MainActor
final class FeedReaderModelTests: XCTestCase {
    func testPreparingSearchKeepsCacheSelectionAndBookmarkSavingAvailable() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        await store.setPreparationGated()
        let searcher = PreparationTestSearcher(article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: UnchangedFetcher(), searcher: searcher,
                                    searchDebounce: .zero)
        await model.initialize()
        XCTAssertFalse(model.isLoading)
        XCTAssertTrue(model.isPreparingSearch)
        XCTAssertTrue(model.preparationMessage?.contains("12件") == true)
        model.selectedArticleID = fixture.oldArticle.id
        model.searchText = "needle"
        XCTAssertEqual(model.visibleArticles, [fixture.oldArticle])
        XCTAssertEqual(model.selectedArticle, fixture.oldArticle)
        XCTAssertFalse(model.isSearching)
        await model.setBookmark(true, article: fixture.oldArticle)
        XCTAssertEqual(model.bookmarkState(for: fixture.oldArticle), true)
        let countBeforeReady = await searcher.calls
        XCTAssertEqual(countBeforeReady, 0)

        await store.finishPreparation()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(3))
        while (model.isPreparingSearch || model.searchResults.isEmpty) && clock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertFalse(model.isPreparingSearch)
        XCTAssertEqual(model.searchResults.map(\.article.id), [fixture.oldArticle.id])
        XCTAssertTrue(model.showsSearchResults)
    }

    func testPreparationRetryStartsPendingQueryWhenAnotherSceneAlreadyFinished() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        await store.setPreparationGated()
        let searcher = PreparationTestSearcher(article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: UnchangedFetcher(), searcher: searcher,
                                    searchDebounce: .zero)
        await model.initialize()
        model.searchText = "needle"
        await store.finishPreparation(fail: true)
        let clock = ContinuousClock()
        let failureDeadline = clock.now.advanced(by: .seconds(3))
        while model.preparationFailure == nil && clock.now < failureDeadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNotNil(model.preparationFailure)
        XCTAssertEqual(model.visibleArticles, [fixture.oldArticle])
        // Another scene completes after this scene's failure, before retry.
        await store.finishPreparation()
        await model.startSearchPreparation()
        let resultDeadline = clock.now.advanced(by: .seconds(3))
        while model.searchResults.isEmpty && clock.now < resultDeadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNil(model.preparationFailure)
        XCTAssertFalse(model.isPreparingSearch)
        XCTAssertEqual(model.searchResults.map(\.article.id), [fixture.oldArticle.id])
    }

    func testOldBookmarkedSnapshotSurvivesRecentArticleLimitAndReopen() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try FeedLibraryStore(directory: directory)
        let subscription = try FeedSubscription(url: URL(string: "https://example.com/feed")!)
        let bookmarked = FeedArticle(
            id: "old-bookmark", feedID: subscription.id, title: "Saved older article", url: nil,
            content: "Available offline", publishedAt: Date(timeIntervalSince1970: 1)
        )
        let recent = (0..<2_000).map { index in
            FeedArticle(
                id: "recent-\(index)", feedID: subscription.id, title: "Recent \(index)", url: nil,
                content: "Recent body", publishedAt: Date(timeIntervalSince1970: 10_000 + Double(index))
            )
        }
        try await store.saveFetchedFeed(ParsedFeed(id: subscription.id, sourceURL: subscription.url, title: "Feed", articles: recent + [bookmarked]))
        try await store.setBookmarked(articleID: bookmarked.id, bookmarked: true)
        // Also cover the overlap: a recent bookmarked article must appear once.
        try await store.setBookmarked(articleID: recent[0].id, bookmarked: true)
        let reopened = try FeedLibraryStore(directory: directory)
        let model = FeedReaderModel(store: reopened, fetcher: UnchangedFetcher())

        await model.initialize()
        model.showsBookmarksOnly = true
        model.selectedArticleID = bookmarked.id

        XCTAssertEqual(model.articles.count, 2_001)
        XCTAssertEqual(Set(model.articles.map(\.id)).count, 2_001)
        XCTAssertEqual(model.visibleArticles.map(\.id), [recent[0].id, bookmarked.id])
        XCTAssertEqual(model.selectedArticle, bookmarked)
        XCTAssertEqual(model.selectedArticle?.translationSourceBody, "Available offline")
    }

    func testRefreshFailurePreservesCachedArticle() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: FailingFetcher())

        await model.initialize()

        XCTAssertEqual(model.articles, [fixture.oldArticle])
        XCTAssertFalse(model.failureByFeed.isEmpty)
    }

    func testRefreshPreservesNilAndStillVisibleArticleSelections() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: UnchangedFetcher())

        await model.initialize()
        XCTAssertNil(model.selectedArticleID)

        await model.refresh()
        XCTAssertNil(model.selectedArticleID)

        model.selectedArticleID = fixture.oldArticle.id
        await model.refresh()
        XCTAssertEqual(model.selectedArticleID, fixture.oldArticle.id)

        model.selectedArticleID = "no-longer-visible"
        await model.refresh()
        XCTAssertNil(model.selectedArticleID)
    }

    func testRemovingSelectedBookmarkClearsFilteredSelection() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: UnchangedFetcher())
        await model.initialize()
        await model.setBookmark(true, article: fixture.oldArticle)
        model.showsBookmarksOnly = true
        model.selectedArticleID = fixture.oldArticle.id

        await model.setBookmark(false, article: fixture.oldArticle)

        XCTAssertNil(model.selectedArticleID)
        XCTAssertNil(model.selectedArticle)
    }

    func testUnbookmarkingOrphanedSnapshotRemovesItFromEveryFilterAndSelection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fixture = try Fixture()
        let translation = ArticleTranslation(
            articleID: fixture.oldArticle.id,
            sourceFingerprint: fixture.oldArticle.sourceFingerprint,
            targetLanguage: "ja",
            title: "訳",
            body: "翻訳"
        )
        let persistedStore = try FeedLibraryStore(directory: directory)
        try await persistedStore.saveFetchedFeed(ParsedFeed(
            id: fixture.subscription.id,
            sourceURL: fixture.subscription.url,
            title: "Example",
            articles: [fixture.oldArticle]
        ))
        try await persistedStore.saveTranslation(translation)
        let store = ReloadFailingFeedStore(store: persistedStore)
        let model = FeedReaderModel(store: store, fetcher: UnchangedFetcher())
        await model.initialize()
        await model.setBookmark(true, article: fixture.oldArticle)
        await model.remove(fixture.subscription)
        model.selectedArticleID = fixture.oldArticle.id

        XCTAssertEqual(model.articles, [fixture.oldArticle])
        XCTAssertEqual(model.selectedArticle, fixture.oldArticle)
        await store.failReloadAfterNextBookmark()
        await model.setBookmark(false, article: fixture.oldArticle)

        XCTAssertTrue(model.articles.isEmpty)
        XCTAssertTrue(model.visibleArticles.isEmpty)
        XCTAssertFalse(model.bookmarkedIDs.contains(fixture.oldArticle.id))
        XCTAssertNil(model.selectedArticleID)
        XCTAssertNil(model.selectedArticle)
        model.showsBookmarksOnly = true
        XCTAssertTrue(model.visibleArticles.isEmpty)
        model.showsBookmarksOnly = false
        XCTAssertTrue(model.visibleArticles.isEmpty)
        XCTAssertTrue(model.message.hasPrefix("ブックマークは保存しましたが、保存済み記事の再読み込みに失敗しました:"))
        let persistedArticles = try await persistedStore.articles()
        let persistedBookmarks = try await persistedStore.bookmarkedArticles()
        XCTAssertTrue(persistedArticles.isEmpty)
        XCTAssertTrue(persistedBookmarks.isEmpty)
        do {
            _ = try await persistedStore.translation(articleID: fixture.oldArticle.id, targetLanguage: "ja")
            XCTFail("Removing the orphaned article must also remove its translation")
        } catch {
            XCTAssertEqual(error as? FeedError, .articleNotFound)
        }
    }

    func testOtherSceneRemovalAndFailedReloadUsesCommittedUnbookmarkOutcome() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fixture = try Fixture()
        let translation = ArticleTranslation(
            articleID: fixture.oldArticle.id,
            sourceFingerprint: fixture.oldArticle.sourceFingerprint,
            targetLanguage: "ja",
            title: "訳",
            body: "翻訳"
        )
        let persistedStore = try FeedLibraryStore(directory: directory)
        try await persistedStore.saveFetchedFeed(ParsedFeed(
            id: fixture.subscription.id,
            sourceURL: fixture.subscription.url,
            title: "Example",
            articles: [fixture.oldArticle]
        ))
        try await persistedStore.saveTranslation(translation)
        try await persistedStore.setBookmarked(articleID: fixture.oldArticle.id, bookmarked: true)
        let store = ReloadFailingFeedStore(store: persistedStore)
        let model = FeedReaderModel(store: store, fetcher: UnchangedFetcher())
        await model.initialize()
        model.selectedArticleID = fixture.oldArticle.id

        let otherScene = try FeedLibraryStore(directory: directory)
        try await otherScene.removeSubscription(id: fixture.subscription.id)
        XCTAssertEqual(model.subscriptions, [fixture.subscription])
        await store.failReloadAfterNextBookmark()

        await model.setBookmark(false, article: fixture.oldArticle)

        XCTAssertTrue(model.articles.isEmpty)
        XCTAssertTrue(model.visibleArticles.isEmpty)
        XCTAssertFalse(model.bookmarkedIDs.contains(fixture.oldArticle.id))
        XCTAssertNil(model.selectedArticleID)
        XCTAssertNil(model.selectedArticle)
        model.showsBookmarksOnly = true
        XCTAssertTrue(model.visibleArticles.isEmpty)
        model.showsBookmarksOnly = false
        XCTAssertTrue(model.visibleArticles.isEmpty)
        XCTAssertTrue(model.message.hasPrefix("ブックマークは保存しましたが、保存済み記事の再読み込みに失敗しました:"))
        let persistedArticles = try await persistedStore.articles()
        let persistedBookmarks = try await persistedStore.bookmarkedArticles()
        XCTAssertTrue(persistedArticles.isEmpty)
        XCTAssertTrue(persistedBookmarks.isEmpty)
        do {
            _ = try await persistedStore.translation(articleID: fixture.oldArticle.id, targetLanguage: "ja")
            XCTFail("The committed deletion must also remove the cached translation")
        } catch {
            XCTAssertEqual(error as? FeedError, .articleNotFound)
        }
    }

    func testUnbookmarkingSubscribedArticleRetainsArticleAndSelection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fixture = try Fixture()
        let store = try FeedLibraryStore(directory: directory)
        try await store.saveFetchedFeed(ParsedFeed(
            id: fixture.subscription.id,
            sourceURL: fixture.subscription.url,
            title: "Example",
            articles: [fixture.oldArticle]
        ))
        let model = FeedReaderModel(store: store, fetcher: UnchangedFetcher())
        await model.initialize()
        await model.setBookmark(true, article: fixture.oldArticle)
        model.selectedArticleID = fixture.oldArticle.id

        await model.setBookmark(false, article: fixture.oldArticle)

        XCTAssertEqual(model.articles, [fixture.oldArticle])
        XCTAssertEqual(model.visibleArticles, [fixture.oldArticle])
        XCTAssertEqual(model.selectedArticleID, fixture.oldArticle.id)
        XCTAssertEqual(model.selectedArticle, fixture.oldArticle)
        XCTAssertFalse(model.bookmarkedIDs.contains(fixture.oldArticle.id))
        let persistedArticles = try await store.articles()
        let persistedBookmarks = try await store.bookmarkedArticles()
        XCTAssertEqual(persistedArticles, [fixture.oldArticle])
        XCTAssertTrue(persistedBookmarks.isEmpty)
    }

    func testRemovalDuringFetchDoesNotResurrectSubscription() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let fetcher = GatedFetcher(result: .updated(fixture.updatedFeed, eTag: nil, lastModified: nil))
        let model = FeedReaderModel(store: store, fetcher: fetcher)
        let loading = Task { await model.initialize() }
        await fetcher.waitUntilStarted()

        await model.remove(fixture.subscription)
        await fetcher.finish()
        await loading.value

        XCTAssertTrue(model.subscriptions.isEmpty)
        let storedSubscriptions = await store.subscriptions()
        XCTAssertTrue(storedSubscriptions.isEmpty)
    }

    func testOverlappingRefreshIsIgnored() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let fetcher = GatedFetcher(result: .notModified)
        let model = FeedReaderModel(store: store, fetcher: fetcher)
        let loading = Task { await model.initialize() }
        await fetcher.waitUntilStarted()

        await model.refresh()
        let callCount = await fetcher.callCount
        XCTAssertEqual(callCount, 1)
        await fetcher.finish()
        await loading.value
    }

    func testRemoveAndReAddDuringFetchIgnoresOldResponseAndRunsQueuedFetch() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let fetcher = GatedFetcher(result: .updated(fixture.updatedFeed, eTag: nil, lastModified: nil))
        let model = FeedReaderModel(store: store, fetcher: fetcher)
        let loading = Task { await model.initialize() }
        await fetcher.waitUntilStarted(1)

        await model.remove(fixture.subscription)
        model.feedURL = fixture.subscription.url.absoluteString
        await model.addEnteredFeed()
        await fetcher.finish()
        await fetcher.waitUntilStarted(2)

        let callCount = await fetcher.callCount
        XCTAssertEqual(callCount, 2)
        await fetcher.finish()
        await loading.value
        XCTAssertEqual(model.subscriptions.map(\.id), [fixture.subscription.id])
        XCTAssertEqual(model.articles, fixture.updatedFeed.articles)
    }

    func testStaleAndCancelledTranslationResultsAreIgnored() throws {
        let fixture = try Fixture()
        let result = TranslationResultModel()
        let first = TranslationSnapshot(article: fixture.oldArticle)
        let newer = TranslationSnapshot(article: fixture.updatedFeed.articles[0])
        let request = result.begin(snapshot: first)
        let translation = ArticleTranslation(articleID: first.articleID, sourceFingerprint: first.sourceFingerprint, targetLanguage: "ja", title: "訳", body: "本文")

        XCTAssertFalse(result.stage(translation, for: request, current: newer))
        result.cancel()
        XCTAssertFalse(result.stage(translation, for: request, current: first))
        XCTAssertNil(result.translation)
    }

    func testFailedTranslationSaveStaysUnsavedAndCanRetrySameSnapshot() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        await store.setTranslationSaveFailure(true)
        let model = FeedReaderModel(store: store, fetcher: FailingFetcher())
        let result = TranslationResultModel()
        let snapshot = TranslationSnapshot(article: fixture.oldArticle)
        let value = ArticleTranslation(articleID: snapshot.articleID, sourceFingerprint: snapshot.sourceFingerprint, targetLanguage: "ja", title: "訳", body: "本文")
        let first = result.begin(snapshot: snapshot)
        XCTAssertTrue(result.stage(value, for: first, current: snapshot))
        do {
            try await model.saveTranslation(value)
            XCTFail("The first save must fail")
        } catch {
            result.saveFailed(error, for: first, current: snapshot)
        }
        XCTAssertFalse(result.isSaved)
        XCTAssertEqual(result.translation, value)

        await store.setTranslationSaveFailure(false)
        let retry = result.begin(snapshot: snapshot)
        try await model.saveTranslation(value)
        result.saved(value, for: retry, current: snapshot)
        XCTAssertTrue(result.isSaved)
        let stored = await store.translation(articleID: snapshot.articleID, targetLanguage: "ja")
        XCTAssertEqual(stored, value)
    }

    func testLateCacheReadCannotOverwriteGeneratedOrCancelledTranslationState() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let snapshot = TranslationSnapshot(article: fixture.oldArticle)
        let cached = ArticleTranslation(articleID: snapshot.articleID, sourceFingerprint: snapshot.sourceFingerprint, targetLanguage: "ja", title: "cached", body: "cached")
        await store.seedTranslation(cached)
        await store.setTranslationReadGated(true)
        let model = FeedReaderModel(store: store, fetcher: FailingFetcher())
        let result = TranslationResultModel()
        let cacheRequest = result.beginCacheLoad(snapshot: snapshot)
        let read = Task { try await model.cachedTranslation(for: snapshot) }
        await store.waitUntilTranslationReadStarted()

        let translationRequest = result.begin(snapshot: snapshot)
        let generated = ArticleTranslation(articleID: snapshot.articleID, sourceFingerprint: snapshot.sourceFingerprint, targetLanguage: "ja", title: "generated", body: "generated")
        XCTAssertTrue(result.stage(generated, for: translationRequest, current: snapshot))
        await store.finishTranslationRead()
        let lateCached = try await read.value
        result.loaded(lateCached, for: cacheRequest, current: snapshot)
        XCTAssertEqual(result.translation, generated)
        XCTAssertFalse(result.isSaved)

        await store.setTranslationReadGated(true)
        let cancelledCache = result.beginCacheLoad(snapshot: snapshot)
        let cancelledRead = Task { try await model.cachedTranslation(for: snapshot) }
        await store.waitUntilTranslationReadStarted()
        result.cancel()
        await store.finishTranslationRead()
        result.loaded(try await cancelledRead.value, for: cancelledCache, current: snapshot)
        XCTAssertEqual(result.translation, generated)
        XCTAssertFalse(result.isSaved)
    }

    func testCacheLoadCannotOverwriteStagedTranslationAfterSaveFailure() throws {
        let fixture = try Fixture()
        let snapshot = TranslationSnapshot(article: fixture.oldArticle)
        let result = TranslationResultModel()
        let translationRequest = result.begin(snapshot: snapshot)
        let generated = ArticleTranslation(
            articleID: snapshot.articleID, sourceFingerprint: snapshot.sourceFingerprint,
            targetLanguage: "ja", title: "generated", body: "generated"
        )
        XCTAssertTrue(result.stage(generated, for: translationRequest, current: snapshot))
        result.saveFailed(FeedError.unavailable, for: translationRequest, current: snapshot)
        let cacheRequest = result.beginCacheLoad(snapshot: snapshot)
        let olderCached = ArticleTranslation(
            articleID: snapshot.articleID, sourceFingerprint: snapshot.sourceFingerprint,
            targetLanguage: "ja", title: "cached", body: "cached"
        )

        result.loaded(olderCached, for: cacheRequest, current: snapshot)

        XCTAssertEqual(result.translation, generated)
        XCTAssertFalse(result.isSaved)
    }

    func testLateCacheReadForArticleAIsRejectedAfterArticleBSelection() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: FailingFetcher())
        let result = TranslationResultModel()
        let first = TranslationSnapshot(article: fixture.oldArticle)
        let articleB = FeedArticle(
            id: "article-b",
            feedID: fixture.subscription.id,
            remoteID: "two",
            title: "Other",
            url: nil,
            content: "Other body"
        )
        let second = TranslationSnapshot(article: articleB)
        let cached = ArticleTranslation(articleID: first.articleID, sourceFingerprint: first.sourceFingerprint, targetLanguage: "ja", title: "old", body: "old")
        await store.seedTranslation(cached)
        await store.setTranslationReadGated(true)
        let request = result.beginCacheLoad(snapshot: first)
        let read = Task { try await model.cachedTranslation(for: first) }
        await store.waitUntilTranslationReadStarted()
        await store.finishTranslationRead()

        result.loaded(try await read.value, for: request, current: second)
        XCTAssertNil(result.translation)
    }

    func testLateCacheReadIsRejectedAfterSameArticleSourceChanges() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: FailingFetcher())
        let result = TranslationResultModel()
        let oldSource = TranslationSnapshot(article: fixture.oldArticle)
        let newSource = TranslationSnapshot(article: fixture.updatedFeed.articles[0])
        let cached = ArticleTranslation(
            articleID: oldSource.articleID,
            sourceFingerprint: oldSource.sourceFingerprint,
            targetLanguage: "ja",
            title: "old",
            body: "old"
        )
        await store.seedTranslation(cached)
        await store.setTranslationReadGated(true)
        let request = result.beginCacheLoad(snapshot: oldSource)
        let read = Task { try await model.cachedTranslation(for: oldSource) }
        await store.waitUntilTranslationReadStarted()

        await store.finishTranslationRead()
        result.loaded(try await read.value, for: request, current: newSource)

        XCTAssertEqual(oldSource.articleID, newSource.articleID)
        XCTAssertNotEqual(oldSource.sourceFingerprint, newSource.sourceFingerprint)
        XCTAssertNil(result.translation)
        let currentTranslation = try await model.cachedTranslation(for: newSource)
        XCTAssertNil(currentTranslation)
    }

    func testBookmarkSaveFailurePreservesArticlesBookmarkAndSelection() async throws {
        let fixture = try Fixture()
        let store = MemoryFeedStore(subscription: fixture.subscription, article: fixture.oldArticle)
        let model = FeedReaderModel(store: store, fetcher: FailingFetcher())
        await model.initialize()
        await model.setBookmark(true, article: fixture.oldArticle)
        model.selectedArticleID = fixture.oldArticle.id
        await store.setBookmarkSaveFailure(true)

        await model.setBookmark(false, article: fixture.oldArticle)

        XCTAssertEqual(model.articles, [fixture.oldArticle])
        XCTAssertEqual(model.visibleArticles, [fixture.oldArticle])
        XCTAssertEqual(model.selectedArticleID, fixture.oldArticle.id)
        XCTAssertEqual(model.selectedArticle, fixture.oldArticle)
        XCTAssertTrue(model.bookmarkedIDs.contains(fixture.oldArticle.id))
        XCTAssertTrue(model.message.hasPrefix("ブックマークを保存できませんでした:"))
        let bookmarkAfterFailure = await store.isBookmarked(articleID: fixture.oldArticle.id)
        XCTAssertTrue(bookmarkAfterFailure)
        let articlesAfterFailure = await store.articles(feedID: nil, limit: 10)
        XCTAssertEqual(articlesAfterFailure, [fixture.oldArticle])

        await store.setBookmarkSaveFailure(false)
        await model.setBookmark(false, article: fixture.oldArticle)
        XCTAssertFalse(model.bookmarkedIDs.contains(fixture.oldArticle.id))
        let bookmarkAfterRetry = await store.isBookmarked(articleID: fixture.oldArticle.id)
        XCTAssertFalse(bookmarkAfterRetry)
    }
}

private struct Fixture {
    let subscription: FeedSubscription
    let oldArticle: FeedArticle
    let updatedFeed: ParsedFeed

    init() throws {
        let url = URL(string: "https://example.com/feed.xml")!
        subscription = try FeedSubscription(url: url, title: "Example")
        oldArticle = FeedArticle(id: "article", feedID: subscription.id, remoteID: "one", title: "Before", url: nil, content: "Old")
        let updated = FeedArticle(id: "article", feedID: subscription.id, remoteID: "one", title: "After", url: nil, content: "New")
        updatedFeed = ParsedFeed(id: subscription.id, sourceURL: subscription.url, title: "Example", articles: [updated])
    }
}

private struct FailingFetcher: FeedFetching {
    func fetch(_ subscription: FeedSubscription) async throws -> FeedFetchResult { throw FeedError.unavailable }
}

private struct UnchangedFetcher: FeedFetching {
    func fetch(_ subscription: FeedSubscription) async throws -> FeedFetchResult { .notModified }
}

private actor ReloadFailingFeedStore: FeedLibraryStoring {
    private let store: FeedLibraryStore
    private var shouldFailReloadAfterBookmark = false
    private var pendingReloadFailure = false

    init(store: FeedLibraryStore) {
        self.store = store
    }

    func failReloadAfterNextBookmark() {
        shouldFailReloadAfterBookmark = true
    }

    func subscriptions() async throws -> [FeedSubscription] {
        if pendingReloadFailure {
            pendingReloadFailure = false
            throw FeedError.unavailable
        }
        return try await store.subscriptions()
    }

    func addSubscription(url: URL, title: String?) async throws -> FeedSubscription {
        try await store.addSubscription(url: url, title: title)
    }

    func removeSubscription(id: String) async throws -> SubscriptionRemovalResult {
        try await store.removeSubscription(id: id)
    }

    func saveFetchedFeedIfSubscribed(
        _ feed: ParsedFeed,
        eTag: String?,
        lastModified: String?
    ) async throws -> Bool {
        try await store.saveFetchedFeedIfSubscribed(feed, eTag: eTag, lastModified: lastModified)
    }

    func articles(feedID: String?, limit: Int) async throws -> [FeedArticle] {
        try await store.articles(feedID: feedID, limit: limit)
    }

    func bookmarkedArticles(limit: Int) async throws -> [FeedArticle] {
        try await store.bookmarkedArticles(limit: limit)
    }

    func isBookmarked(articleID: String) async throws -> Bool {
        try await store.isBookmarked(articleID: articleID)
    }

    func setBookmarked(articleID: String, bookmarked: Bool) async throws -> BookmarkMutationResult {
        let result = try await store.setBookmarked(articleID: articleID, bookmarked: bookmarked)
        if shouldFailReloadAfterBookmark {
            shouldFailReloadAfterBookmark = false
            pendingReloadFailure = true
        }
        return result
    }

    func translation(articleID: String, targetLanguage: String) async throws -> ArticleTranslation? {
        try await store.translation(articleID: articleID, targetLanguage: targetLanguage)
    }

    func saveTranslation(_ translation: ArticleTranslation) async throws {
        try await store.saveTranslation(translation)
    }
}

private actor GatedFetcher: FeedFetching {
    private let result: FeedFetchResult
    private var fetchContinuation: CheckedContinuation<Void, Never>?
    private var startWaiter: (count: Int, continuation: CheckedContinuation<Void, Never>)?
    private(set) var callCount = 0

    init(result: FeedFetchResult) { self.result = result }

    func fetch(_ subscription: FeedSubscription) async throws -> FeedFetchResult {
        callCount += 1
        if let startWaiter, callCount >= startWaiter.count {
            startWaiter.continuation.resume()
            self.startWaiter = nil
        }
        await withCheckedContinuation { fetchContinuation = $0 }
        return result
    }

    func waitUntilStarted(_ expectedCount: Int = 1) async {
        guard callCount < expectedCount else { return }
        await withCheckedContinuation { startWaiter = (expectedCount, $0) }
    }

    func finish() {
        fetchContinuation?.resume()
        fetchContinuation = nil
    }
}

private actor PreparationTestSearcher: ArticleSearching {
    let article: FeedArticle
    private(set) var calls = 0
    init(article: FeedArticle) { self.article = article }
    func searchArticles(_ request: ArticleSearchRequest) -> ArticleSearchPage {
        calls += 1
        return ArticleSearchPage(results: [ArticleSearchResult(article: article, translation: nil,
                                                               cursor: 1, isBookmarked: true)], nextCursor: nil)
    }
}

private actor MemoryFeedStore: FeedLibraryStoring, ArticleSearchPreparing {
    private var preparationState: ArticleSearchPreparation = .ready
    private var preparationGate: CheckedContinuation<Void, Never>?
    private var preparationFails = false
    func setPreparationGated() { preparationState = .preparing(processedArticles: 12) }
    func searchPreparationStatus() -> ArticleSearchPreparation { preparationState }
    func prepareSearchBatch() async throws -> ArticleSearchPreparation {
        if !preparationState.isReady && !preparationFails {
            await withCheckedContinuation { preparationGate = $0 }
        }
        if preparationFails { throw FeedError.unavailable }
        return preparationState
    }
    func finishPreparation(fail: Bool = false) {
        preparationFails = fail
        preparationState = fail ? .preparing(processedArticles: 12) : .ready
        preparationGate?.resume()
        preparationGate = nil
    }

    private var savedSubscriptions: [FeedSubscription]
    private var savedArticles: [FeedArticle]
    private var bookmarks: Set<String> = []
    private var translations: [String: ArticleTranslation] = [:]
    private var translationSaveFails = false
    private var bookmarkSaveFails = false
    private var translationReadGated = false
    private var translationReadStarted: CheckedContinuation<Void, Never>?
    private var translationReadGate: CheckedContinuation<Void, Never>?

    init(subscription: FeedSubscription, article: FeedArticle) {
        savedSubscriptions = [subscription]
        savedArticles = [article]
    }

    func subscriptions() -> [FeedSubscription] { savedSubscriptions }
    func addSubscription(url: URL, title: String?) throws -> FeedSubscription {
        let value = try FeedSubscription(url: url, title: title)
        if !savedSubscriptions.contains(where: { $0.id == value.id }) { savedSubscriptions.append(value) }
        return value
    }
    func removeSubscription(id: String) -> SubscriptionRemovalResult {
        let affected = Set(savedArticles.filter { $0.feedID == id }.map(\.id))
        let retained = affected.intersection(bookmarks)
        savedSubscriptions.removeAll { $0.id == id }
        savedArticles.removeAll { $0.feedID == id && !bookmarks.contains($0.id) }
        return SubscriptionRemovalResult(
            retainedArticleIDs: retained, deletedArticleIDs: affected.subtracting(retained)
        )
    }
    func saveFetchedFeedIfSubscribed(_ feed: ParsedFeed, eTag: String?, lastModified: String?) -> Bool {
        guard savedSubscriptions.contains(where: { $0.id == feed.id }) else { return false }
        savedArticles.removeAll { $0.feedID == feed.id }
        savedArticles.append(contentsOf: feed.articles)
        return true
    }
    func articles(feedID: String?, limit: Int) -> [FeedArticle] {
        Array(savedArticles.filter { feedID == nil || $0.feedID == feedID }.prefix(limit))
    }
    func bookmarkedArticles(limit: Int) -> [FeedArticle] {
        Array(savedArticles.filter { bookmarks.contains($0.id) }.prefix(limit))
    }
    func isBookmarked(articleID: String) -> Bool { bookmarks.contains(articleID) }
    func setBookmarked(articleID: String, bookmarked: Bool) throws -> BookmarkMutationResult {
        if bookmarkSaveFails { throw FeedError.unavailable }
        guard savedArticles.contains(where: { $0.id == articleID }) else {
            if bookmarked { throw FeedError.articleNotFound }
            return .articleDeleted
        }
        if bookmarked {
            bookmarks.insert(articleID)
        } else {
            bookmarks.remove(articleID)
            if let article = savedArticles.first(where: { $0.id == articleID }),
               !savedSubscriptions.contains(where: { $0.id == article.feedID }) {
                savedArticles.removeAll { $0.id == articleID }
                translations = translations.filter { $0.value.articleID != articleID }
            }
        }
        return savedArticles.contains(where: { $0.id == articleID }) ? .articleRetained : .articleDeleted
    }
    func translation(articleID: String, targetLanguage: String) async -> ArticleTranslation? {
        if translationReadGated {
            translationReadStarted?.resume()
            translationReadStarted = nil
            await withCheckedContinuation { translationReadGate = $0 }
        }
        return translations[articleID + "\u{0}" + targetLanguage]
    }
    func saveTranslation(_ translation: ArticleTranslation) throws {
        if translationSaveFails { throw FeedError.unavailable }
        guard savedArticles.contains(where: { $0.id == translation.articleID && $0.sourceFingerprint == translation.sourceFingerprint }) else {
            throw FeedError.staleTranslation
        }
        translations[translation.id] = translation
    }
    func setTranslationSaveFailure(_ value: Bool) { translationSaveFails = value }
    func setBookmarkSaveFailure(_ value: Bool) { bookmarkSaveFails = value }
    func seedTranslation(_ value: ArticleTranslation) { translations[value.id] = value }
    func setTranslationReadGated(_ value: Bool) { translationReadGated = value }
    func waitUntilTranslationReadStarted() async {
        guard translationReadGate == nil else { return }
        await withCheckedContinuation { translationReadStarted = $0 }
    }
    func finishTranslationRead() {
        translationReadGated = false
        translationReadGate?.resume()
        translationReadGate = nil
    }
}
