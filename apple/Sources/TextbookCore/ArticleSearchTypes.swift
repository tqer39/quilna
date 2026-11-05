import Foundation

/// Literal, normalized substring terms separated by Unicode whitespace are ANDed.
public struct ArticleSearchRequest: Equatable, Sendable {
    public let text: String
    public let feedID: String?
    public let bookmarksOnly: Bool
    public let limit: Int
    public let before: Int64?

    public init(text: String, feedID: String? = nil, bookmarksOnly: Bool = false,
                limit: Int = 50, before: Int64? = nil) {
        self.text = text
        self.feedID = feedID
        self.bookmarksOnly = bookmarksOnly
        self.limit = limit
        self.before = before
    }
}

public struct ArticleSearchResult: Equatable, Sendable {
    public let article: FeedArticle
    public let translation: ArticleTranslation?
    /// Stable saved/updated-document order; used for keyset pagination.
    public let cursor: Int64
    /// Production searches include the bookmark state from the same read snapshot.
    /// nil means the injected search provider has not supplied an authoritative state.
    public let isBookmarked: Bool?

    public init(article: FeedArticle, translation: ArticleTranslation?, cursor: Int64,
                isBookmarked: Bool? = nil) {
        self.article = article
        self.translation = translation
        self.cursor = cursor
        self.isBookmarked = isBookmarked
    }
}

public struct ArticleSearchPage: Equatable, Sendable {
    public let results: [ArticleSearchResult]
    public let nextCursor: Int64?

    public init(results: [ArticleSearchResult], nextCursor: Int64?) {
        self.results = results
        self.nextCursor = nextCursor
    }
}

public protocol ArticleSearching: Sendable {
    func searchArticles(_ request: ArticleSearchRequest) async throws -> ArticleSearchPage
}

public enum ArticleSearchError: Error, Equatable, Sendable, LocalizedError {
    case invalidQuery, queryTooLong, tooManyTerms, notReady, unavailable, interrupted

    public var errorDescription: String? {
        switch self {
        case .invalidQuery: "検索語に使用できない文字があります。"
        case .queryTooLong: "検索語は正規化後128文字以内で入力してください。"
        case .tooManyTerms: "検索語は空白で区切って8語以内で入力してください。"
        case .notReady: "検索索引を準備しています。"
        case .unavailable: "検索用の保存領域を利用できません。"
        case .interrupted: "検索を中断しました。"
        }
    }
}

/// Progress counts scanned articles, not a percentage of a changing library.
public enum ArticleSearchPreparation: Equatable, Sendable {
    case ready
    case preparing(processedArticles: Int64)

    public var isReady: Bool {
        if case .ready = self { return true }
        return false
    }
}

public protocol ArticleSearchPreparing: Sendable {
    func searchPreparationStatus() async throws -> ArticleSearchPreparation
    func prepareSearchBatch() async throws -> ArticleSearchPreparation
}
