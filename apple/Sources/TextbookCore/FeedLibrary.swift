import Foundation
import CryptoKit
import CSQLite

// MARK: - Public values

/// A value returned by a feed.  Text fields are plain, inert text: clients must
/// not treat either `summary` or `content` as HTML.
public struct FeedArticle: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let feedID: String
    public let remoteID: String?
    public let title: String
    public let url: URL?
    public let summary: String
    public let content: String
    public let publishedAt: Date?

    public init(id: String, feedID: String, remoteID: String? = nil, title: String,
                url: URL?, summary: String = "", content: String = "", publishedAt: Date? = nil) {
        self.id = id; self.feedID = feedID; self.remoteID = remoteID; self.title = title
        self.url = url; self.summary = summary; self.content = content; self.publishedAt = publishedAt
    }

    /// The exact body presented to Translation and stored beside the translated text.
    public var translationSourceBody: String { content.isEmpty ? summary : content }

    /// Changes whenever the exact source text which a translation represents changes.
    public var sourceFingerprint: String { FeedDigest.hex(title + "\u{0}" + translationSourceBody) }
}

public struct ParsedFeed: Equatable, Sendable {
    public let id: String
    public let sourceURL: URL
    public let title: String
    public let articles: [FeedArticle]

    public init(id: String, sourceURL: URL, title: String, articles: [FeedArticle]) {
        self.id = id; self.sourceURL = sourceURL; self.title = title; self.articles = articles
    }
}

public struct FeedSubscription: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let url: URL
    public var title: String?
    public var eTag: String?
    public var lastModified: String?

    public init(url: URL, title: String? = nil, eTag: String? = nil, lastModified: String? = nil) throws {
        let canonical = try FeedURL.feedURL(url)
        id = FeedDigest.hex(canonical.absoluteString)
        self.url = canonical; self.title = title; self.eTag = eTag; self.lastModified = lastModified
    }
}

public struct ArticleTranslation: Codable, Equatable, Sendable, Identifiable {
    public let articleID: String
    public let sourceFingerprint: String
    public let targetLanguage: String
    public let title: String
    public let body: String
    public var id: String { articleID + "\u{0}" + targetLanguage }

    public init(articleID: String, sourceFingerprint: String, targetLanguage: String, title: String, body: String) {
        self.articleID = articleID; self.sourceFingerprint = sourceFingerprint
        self.targetLanguage = targetLanguage; self.title = title; self.body = body
    }
}

public enum BookmarkMutationResult: Equatable, Sendable {
    case articleRetained
    case articleDeleted
}

public struct SubscriptionRemovalResult: Equatable, Sendable {
    public let retainedArticleIDs: Set<String>
    public let deletedArticleIDs: Set<String>

    public init(retainedArticleIDs: Set<String>, deletedArticleIDs: Set<String>) {
        self.retainedArticleIDs = retainedArticleIDs
        self.deletedArticleIDs = deletedArticleIDs
    }
}

public enum FeedError: Error, Equatable, Sendable, LocalizedError {
    case invalidFeedURL, invalidArticleURL, responseTooLarge, httpStatus(Int), notModified
    case redirectDowngrade, malformedXML, unsafeXML, limitExceeded, unavailable
    case corrupted, unsupportedSchema(Int), staleTranslation, articleNotFound

    public var errorDescription: String? {
        switch self {
        case .invalidFeedURL: "フィード URL は認証情報を含まない HTTPS URL である必要があります。"
        case .invalidArticleURL: "記事 URL は HTTP または HTTPS URL である必要があります。"
        case .responseTooLarge: "フィードのサイズが上限を超えています。"
        case .httpStatus(let status): "フィード取得は HTTP \(status) でした。"
        case .notModified: "フィードは更新されていません。"
        case .redirectDowngrade: "HTTPS から HTTP へのリダイレクトは許可されません。"
        case .malformedXML: "フィード XML の形式が不正です。"
        case .unsafeXML: "DTD または外部エンティティを含む XML は許可されません。"
        case .limitExceeded: "フィードが安全な解析上限を超えています。"
        case .unavailable: "フィードライブラリにアクセスできません。"
        case .corrupted: "フィードライブラリの形式を確認できません。"
        case .unsupportedSchema(let version): "未対応のフィードライブラリ版です: \(version)"
        case .staleTranslation: "元の記事が更新されたため、古い翻訳は保存しませんでした。"
        case .articleNotFound: "記事が見つかりません。"
        }
    }
}

// MARK: - Parser

public struct RSSFeedParser: Sendable {
    public static let maximumEntries = 2_000
    public static let maximumTextLength = 512_000
    public static let maximumDepth = 64

    public init() {}

    public func parse(data: Data, responseURL: URL) throws -> ParsedFeed {
        try parse(data: data, responseURL: responseURL, sourceURL: responseURL)
    }

    /// `responseURL` is used to resolve document-relative links, while
    /// `sourceURL` remains the identity of the subscription across redirects.
    func parse(data: Data, responseURL: URL, sourceURL: URL) throws -> ParsedFeed {
        guard data.count <= 2 * 1024 * 1024 else { throw FeedError.responseTooLarge }
        if let declarationError = data.xmlDeclarationError { throw declarationError }
        let responseURL = try FeedURL.feedURL(responseURL)
        let sourceURL = try FeedURL.feedURL(sourceURL)
        let collector = XMLFeedCollector(feedURL: sourceURL, documentURL: responseURL)
        let parser = XMLParser(data: data)
        parser.delegate = collector
        parser.shouldProcessNamespaces = false
        parser.shouldReportNamespacePrefixes = false
        parser.shouldResolveExternalEntities = false
        guard parser.parse(), collector.failure == nil else { throw collector.failure ?? FeedError.malformedXML }
        return try collector.makeFeed()
    }
}

private final class XMLFeedCollector: NSObject, XMLParserDelegate {
    private enum TextKind: Equatable { case plain, html, xhtml }
    private enum TitleScope: Equatable { case feed, entry }
    private struct TextValue {
        private struct Fragment {
            var kind: TextKind
            var value: String
        }
        private var fragments: [Fragment] = []
        private(set) var byteCount = 0

        mutating func append(_ value: String, as kind: TextKind) {
            byteCount += value.utf8.count
            if fragments.last?.kind == kind {
                fragments[fragments.count - 1].value += value
            } else {
                fragments.append(Fragment(kind: kind, value: value))
            }
        }

        var rendered: String {
            var result = ""
            for (index, fragment) in fragments.enumerated() {
                if index > 0,
                   fragments[index - 1].value.last?.isWhitespace == true || fragment.value.first?.isWhitespace == true {
                    result.append(" ")
                }
                result += fragment.kind == .html ? FeedHTML.plainText(fragment.value) : fragment.value
            }
            return FeedHTML.normalizeWhitespace(result)
        }
    }
    private struct Entry {
        var values: [String: TextValue] = [:]
        var link: String?
        var linkBase: URL?
        var base: URL
        var id: String?
        var published: String?
        var updated: String?
    }
    private let feedURL: URL
    private let documentURL: URL
    private var root = ""
    private var depth = 0
    private var path: [String] = []
    private var bases: [URL] = []
    private var textKinds: [TextKind?] = []
    private var feedTitle = TextValue()
    private var entry: Entry?
    private var articles: [FeedArticle] = []
    var failure: FeedError?

    init(feedURL: URL, documentURL: URL) {
        self.feedURL = feedURL
        self.documentURL = documentURL
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String : String] = [:]) {
        depth += 1
        guard depth <= RSSFeedParser.maximumDepth else { failure = .limitExceeded; parser.abortParsing(); return }
        let name = Self.local(qName ?? elementName)
        path.append(name)
        let inherited = bases.last ?? documentURL
        let base = Self.resolve(attributeDict["xml:base"] ?? attributeDict["base"], against: inherited) ?? inherited
        bases.append(base)
        if root.isEmpty { root = name }
        if isTopLevelEntry(name) {
            guard articles.count < RSSFeedParser.maximumEntries else { failure = .limitExceeded; parser.abortParsing(); return }
            entry = Entry(base: base)
        }
        let inheritedKind = textKinds.last ?? nil
        let kind: TextKind?
        if isDirectEntryField(name) || isFeedTitle(name) {
            let type = attributeDict["type"]?.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if root == "feed" {
                kind = type == "html" ? .html : type == "xhtml" ? .xhtml : .plain
            } else {
                // RSS 2.0 descriptions and content:encoded conventionally
                // contain HTML after XML decoding, whether their source used
                // escaped text or CDATA. Titles and identifiers remain text.
                kind = name == "description" || name == "encoded" ? .html : .plain
            }
        } else {
            kind = inheritedKind
        }
        textKinds.append(kind)
        if Self.blockElements.contains(name), isInsideCapturedXHTMLTextConstruct {
            append("\n")
        }
        guard entry != nil else { return }
        if name == "link", isDirectEntryField(name) {
            let relation = (attributeDict["rel"] ?? "alternate").lowercased()
            if relation == "alternate" || relation.isEmpty {
                entry!.linkBase = base
                if let href = attributeDict["href"], let resolved = Self.resolve(href, against: base) {
                    entry!.link = resolved.absoluteString
                }
            }
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { append(string, as: textKinds.last ?? nil) }
    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
        // CDATA only changes XML escaping. The enclosing RSS/Atom text
        // construct still determines whether the resulting value is HTML.
        append(String(decoding: CDATABlock, as: UTF8.self), as: textKinds.last ?? nil)
    }
    func parser(_ parser: XMLParser, foundExternalEntityWithName name: String, systemID: String?, publicID: String?) -> Bool { failure = .unsafeXML; return false }
    func parser(_ parser: XMLParser, foundInternalEntityDeclarationWithName name: String, value: String?) { rejectUnsafeXML(parser) }
    func parser(_ parser: XMLParser, foundExternalEntityDeclarationWithName name: String, publicID: String?, systemID: String?) { rejectUnsafeXML(parser) }
    func parser(_ parser: XMLParser, foundUnparsedEntityDeclarationWithName name: String, publicID: String?, systemID: String?, notationName: String?) { rejectUnsafeXML(parser) }
    func parser(_ parser: XMLParser, foundNotationDeclarationWithName name: String, publicID: String?, systemID: String?) { rejectUnsafeXML(parser) }
    func parser(_ parser: XMLParser, parseErrorOccurred parseError: Error) { if failure == nil { failure = .malformedXML } }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        let name = Self.local(qName ?? elementName)
        if Self.blockElements.contains(name), isInsideCapturedXHTMLTextConstruct {
            append("\n")
        }
        if isTopLevelEntry(name), let current = entry {
            let link = Self.safeArticleURL(Self.resolve(current.link ?? current.values["link"]?.rendered, against: current.linkBase ?? current.base))
            let remoteID = Self.clean(current.id ?? current.values["guid"]?.rendered ?? current.values["id"]?.rendered)
            let title = current.values["title"]?.rendered ?? ""
            let summary = (current.values["description"] ?? current.values["summary"])?.rendered ?? ""
            let content = (current.values["encoded"] ?? current.values["content"])?.rendered ?? summary
            let fallback = link?.absoluteString ?? (title + "\u{0}" + content)
            let feedID = FeedDigest.hex(feedURL.absoluteString)
            let stable = remoteID?.isEmpty == false ? remoteID! : FeedDigest.hex(fallback)
            articles.append(FeedArticle(id: FeedDigest.hex(feedID + "\u{0}" + stable), feedID: feedID, remoteID: remoteID,
                title: title, url: link, summary: summary, content: content,
                publishedAt: FeedDate.parse(current.published ?? current.updated ?? current.values["pubdate"]?.rendered ?? current.values["published"]?.rendered ?? current.values["updated"]?.rendered)))
            entry = nil
        }
        _ = path.popLast(); _ = bases.popLast(); _ = textKinds.popLast(); depth -= 1
    }

    func makeFeed() throws -> ParsedFeed {
        guard root == "rss" || root == "feed" else { throw FeedError.malformedXML }
        var unique: [String: FeedArticle] = [:]
        var order: [String] = []
        for article in articles {
            if unique[article.id] == nil { order.append(article.id) }
            unique[article.id] = article
        }
        return ParsedFeed(
            id: FeedDigest.hex(feedURL.absoluteString), sourceURL: feedURL,
            title: feedTitle.rendered, articles: order.compactMap { unique[$0] }
        )
    }

    private func append(_ string: String, as explicitKind: TextKind? = nil) {
        guard failure == nil else { return }
        if let key = entryField, var e = entry {
            var value = e.values[key] ?? TextValue()
            guard value.byteCount + string.utf8.count <= RSSFeedParser.maximumTextLength else { failure = .limitExceeded; return }
            value.append(string, as: explicitKind ?? .plain)
            e.values[key] = value
            if key == "guid" || key == "id" { e.id = value.rendered }
            if key == "published" || key == "pubdate" { e.published = value.rendered }
            if key == "updated" { e.updated = value.rendered }
            entry = e
        } else if titleScope == .feed {
            guard feedTitle.byteCount + string.utf8.count <= RSSFeedParser.maximumTextLength else { failure = .limitExceeded; return }
            feedTitle.append(string, as: explicitKind ?? .plain)
        }
    }
    private func rejectUnsafeXML(_ parser: XMLParser) {
        failure = .unsafeXML
        parser.abortParsing()
    }
    private var entryField: String? {
        let entryIndex: Int?
        if root == "feed", path.count > 1, path[1] == "entry" {
            entryIndex = 1
        } else if root == "rss", path.count > 2, path[1] == "channel", path[2] == "item" {
            entryIndex = 2
        } else {
            entryIndex = nil
        }
        guard let entryIndex, path.indices.contains(entryIndex + 1) else { return nil }
        let field = path[entryIndex + 1]
        return Self.capturedElements.contains(field) ? field : nil
    }
    private func isDirectEntryField(_ name: String) -> Bool {
        entryField == name && path.last == name
    }
    private func isFeedTitle(_ name: String) -> Bool {
        name == "title" && (path == ["feed", "title"] || path == ["rss", "channel", "title"])
    }
    private var titleScope: TitleScope? {
        if root == "feed" {
            if path.starts(with: ["feed", "title"]) { return .feed }
            if path.starts(with: ["feed", "entry", "title"]) { return .entry }
        } else if root == "rss" {
            if path.starts(with: ["rss", "channel", "title"]) { return .feed }
            if path.starts(with: ["rss", "channel", "item", "title"]) { return .entry }
        }
        return nil
    }
    private var isInsideCapturedXHTMLTextConstruct: Bool {
        guard (textKinds.last ?? nil) == .xhtml else { return false }
        return titleScope != nil || entryField.map(Self.textContainers.contains) == true
    }
    private func isTopLevelEntry(_ name: String) -> Bool {
        (root == "feed" && name == "entry" && path == ["feed", "entry"])
            || (root == "rss" && name == "item" && path == ["rss", "channel", "item"])
    }
    private static func local(_ name: String) -> String { name.split(separator: ":").last.map(String.init)?.lowercased() ?? name.lowercased() }
    private static let capturedElements: Set<String> = ["title", "description", "summary", "encoded", "content", "guid", "id", "link", "published", "pubdate", "updated"]
    private static let textContainers: Set<String> = ["description", "summary", "encoded", "content"]
    private static let blockElements: Set<String> = ["p", "div", "article", "section", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote", "pre", "br"]
    private static func clean(_ text: String?) -> String? { text.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } }
    private static func resolve(_ raw: String?, against base: URL) -> URL? { raw.flatMap { URL(string: $0.trimmingCharacters(in: .whitespacesAndNewlines), relativeTo: base)?.absoluteURL } }
    private static func safeArticleURL(_ url: URL?) -> URL? {
        guard let url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let scheme = parts.scheme?.lowercased(), (scheme == "http" || scheme == "https"),
              parts.host != nil, parts.user == nil, parts.password == nil else { return nil }
        parts.scheme = scheme
        parts.host = parts.host?.lowercased()
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) { parts.port = nil }
        parts.fragment = nil
        return parts.url
    }
}

// MARK: - HTTP

public protocol FeedHTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionFeedTransport: FeedHTTPTransport {
    public init() {}
    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let receiver = BoundedFeedReceiver(limit: 2 * 1024 * 1024)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = request.timeoutInterval
        configuration.timeoutIntervalForResource = request.timeoutInterval
        let session = URLSession(configuration: configuration, delegate: receiver, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        return try await receiver.perform(request, in: session)
    }
}

private final class BoundedFeedReceiver: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let limit: Int
    private let lock = NSLock()
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var response: HTTPURLResponse?
    private var bytes = Data()
    private var terminalError: Error?
    private var task: URLSessionDataTask?
    private var cancelled = false

    init(limit: Int) { self.limit = limit }

    func perform(_ request: URLRequest, in session: URLSession) async throws -> (Data, HTTPURLResponse) {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let dataTask = session.dataTask(with: request)
                let shouldStart = lock.withLock { () -> Bool in
                    if cancelled {
                        return false
                    }
                    self.continuation = continuation
                    task = dataTask
                    return true
                }
                if shouldStart {
                    dataTask.resume()
                } else {
                    continuation.resume(throwing: CancellationError())
                }
            }
        } onCancel: {
            let pending = self.lock.withLock { () -> (CheckedContinuation<(Data, HTTPURLResponse), Error>?, URLSessionDataTask?) in
                self.cancelled = true
                self.terminalError = CancellationError()
                let result = (self.continuation, self.task)
                self.continuation = nil
                self.task = nil
                return result
            }
            pending.1?.cancel()
            pending.0?.resume(throwing: CancellationError())
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        if request.url?.scheme?.lowercased() == "http" {
            lock.withLock { terminalError = FeedError.redirectDowngrade }
            completionHandler(nil)
        } else { completionHandler(request) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            lock.withLock { terminalError = FeedError.unavailable }
            completionHandler(.cancel)
            return
        }
        if response.expectedContentLength > Int64(limit) {
            lock.withLock { terminalError = FeedError.responseTooLarge }
            completionHandler(.cancel)
            return
        }
        lock.withLock { self.response = http }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let shouldCancel = lock.withLock { () -> Bool in
            guard terminalError == nil else { return true }
            guard data.count <= limit - bytes.count else {
                terminalError = FeedError.responseTooLarge
                bytes.removeAll(keepingCapacity: false)
                return true
            }
            bytes.append(data)
            return false
        }
        if shouldCancel { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let result: Result<(Data, HTTPURLResponse), Error> = lock.withLock {
            if let terminalError { return .failure(terminalError) }
            if let error { return .failure(error) }
            guard let response else { return .failure(FeedError.unavailable) }
            return .success((bytes, response))
        }
        let pending = lock.withLock { () -> CheckedContinuation<(Data, HTTPURLResponse), Error>? in
            defer { continuation = nil }
            self.task = nil
            return continuation
        }
        pending?.resume(with: result)
    }
}

public enum FeedFetchResult: Sendable, Equatable {
    case updated(ParsedFeed, eTag: String?, lastModified: String?)
    case notModified
}

public struct FeedHTTPClient: Sendable {
    private let transport: any FeedHTTPTransport
    public init(transport: any FeedHTTPTransport = URLSessionFeedTransport()) { self.transport = transport }

    public func fetch(_ subscription: FeedSubscription) async throws -> FeedFetchResult {
        let url = try FeedURL.feedURL(subscription.url)
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("application/rss+xml, application/atom+xml, application/xml, text/xml", forHTTPHeaderField: "Accept")
        if let eTag = subscription.eTag { request.setValue(eTag, forHTTPHeaderField: "If-None-Match") }
        if let modified = subscription.lastModified { request.setValue(modified, forHTTPHeaderField: "If-Modified-Since") }
        let (data, response) = try await transport.data(for: request)
        guard response.url?.scheme?.lowercased() != "http" else { throw FeedError.redirectDowngrade }
        guard data.count <= 2 * 1024 * 1024 else { throw FeedError.responseTooLarge }
        if response.statusCode == 304 { return .notModified }
        guard (200 ... 299).contains(response.statusCode) else { throw FeedError.httpStatus(response.statusCode) }
        let finalURL = response.url ?? url
        let parsed = try await Task.detached(priority: .userInitiated) {
            try RSSFeedParser().parse(data: data, responseURL: finalURL, sourceURL: url)
        }.value
        return .updated(parsed, eTag: response.value(forHTTPHeaderField: "ETag"), lastModified: response.value(forHTTPHeaderField: "Last-Modified"))
    }
}

// MARK: - Durable library

private final class FeedSQLiteBusyObserver: Sendable {
    let notify: @Sendable () -> Void
    init(_ notify: @escaping @Sendable () -> Void) { self.notify = notify }
}

private final class FeedSQLiteHandle: @unchecked Sendable {
    let db: OpaquePointer
    private let busyObserver: FeedSQLiteBusyObserver?

    init(_ db: OpaquePointer, onWriteContention: (@Sendable () -> Void)? = nil) {
        self.db = db
        busyObserver = onWriteContention.map(FeedSQLiteBusyObserver.init)
        sqlite3_busy_timeout(db, 2_000)
        if let busyObserver {
            // The internal observer lets concurrency tests coordinate at an
            // actual SQLite lock, without exposing this connection's pointer.
            sqlite3_busy_handler(db, { context, attempts in
                guard let context, attempts < 200 else { return 0 }
                let observer = Unmanaged<FeedSQLiteBusyObserver>.fromOpaque(context).takeUnretainedValue()
                observer.notify()
                Thread.sleep(forTimeInterval: 0.01)
                return 1
            }, Unmanaged.passUnretained(busyObserver).toOpaque())
        }
    }

    deinit { sqlite3_close_v2(db) }
}

public actor FeedLibraryStore: ArticleSearching, ArticleSearchPreparing {
    private static let version = 1
    private let connection: FeedSQLiteHandle
    private let beforeCommit: (@Sendable () -> Void)?
    private nonisolated let searchReader: FeedLibrarySearchReader

    public init(directory: URL, deferSearchPreparation: Bool = false) throws {
        try self.init(url: directory.appendingPathComponent("feed-library.sqlite"), onWriteContention: nil,
                      beforeCommit: nil, deferSearchPreparation: deferSearchPreparation)
    }
    public init(url: URL) throws { try self.init(url: url, onWriteContention: nil, beforeCommit: nil) }

    @_spi(Testing)
    public init(directory: URL, beforeCommit: @escaping @Sendable () -> Void) throws {
        try self.init(
            url: directory.appendingPathComponent("feed-library.sqlite"),
            onWriteContention: nil, beforeCommit: beforeCommit
        )
    }

    init(url: URL, onWriteContention: (@Sendable () -> Void)?) throws {
        try self.init(url: url, onWriteContention: onWriteContention, beforeCommit: nil)
    }

    private init(url: URL, onWriteContention: (@Sendable () -> Void)?,
                 beforeCommit: (@Sendable () -> Void)?, deferSearchPreparation: Bool = false) throws {
        do { try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) } catch { throw FeedError.unavailable }
        var opened: OpaquePointer?
        guard sqlite3_open_v2(url.path, &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let opened else { if let opened { sqlite3_close_v2(opened) }; throw FeedError.unavailable }
        connection = FeedSQLiteHandle(opened, onWriteContention: onWriteContention)
        self.beforeCommit = beforeCommit
        guard try Self.scalarText(opened, "PRAGMA quick_check") == "ok" else { throw FeedError.corrupted }
        let v = try Self.scalarInteger(opened, "PRAGMA user_version")
        guard v == 0 || v == Self.version else { throw FeedError.unsupportedSchema(v) }
        if v == 0 {
            try Self.exec(opened, "BEGIN IMMEDIATE")
            do {
                let lockedVersion = try Self.scalarInteger(opened, "PRAGMA user_version")
                if lockedVersion == 0 {
                    guard try Self.scalarInteger(opened, "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'") == 0 else {
                        throw FeedError.corrupted
                    }
                    try Self.exec(opened, Self.schema)
                } else if lockedVersion != Self.version {
                    throw FeedError.unsupportedSchema(lockedVersion)
                }
                try Self.exec(opened, "COMMIT")
            } catch { try? Self.exec(opened, "ROLLBACK"); throw error }
        }
        try Self.validateSchema(opened)
        try FeedArticleSearchIndex.preflight(on: opened)
        guard try Self.scalarText(opened, "PRAGMA journal_mode=WAL").lowercased() == "wal" else {
            throw FeedError.unavailable
        }
        if try !Self.hasRequiredReadIndexes(opened) {
            try Self.exec(opened, "BEGIN IMMEDIATE")
            do {
                if try !Self.hasRequiredReadIndexes(opened) {
                    try Self.installMissingReadIndexes(opened)
                }
                try Self.exec(opened, "COMMIT")
            } catch {
                try? Self.exec(opened, "ROLLBACK")
                throw error
            }
        }
        try FeedArticleSearchIndex.prepare(on: opened, deferred: deferSearchPreparation)
        searchReader = try FeedLibrarySearchReader(url: url)
    }

    public func searchPreparationStatus() throws -> ArticleSearchPreparation {
        try FeedArticleSearchIndex.preparationStatus(on: connection.db)
    }

    /// Performs one short transaction; callers yield between batches so cache
    /// reads and user writes can run on this actor before the next batch.
    public func prepareSearchBatch() throws -> ArticleSearchPreparation {
        try FeedArticleSearchIndex.prepareBatch(on: connection.db)
    }

    public nonisolated func searchArticles(_ request: ArticleSearchRequest) async throws -> ArticleSearchPage {
        try await searchReader.search(request)
    }

    public func addSubscription(url: URL, title: String? = nil) throws -> FeedSubscription {
        let subscription = try FeedSubscription(url: url, title: title)
        let s = try Self.prepare(connection.db, "INSERT INTO subscriptions(id,url,title,etag,last_modified) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
        defer { sqlite3_finalize(s) }; try Self.bind(subscription.id, 1, s); try Self.bind(subscription.url.absoluteString, 2, s); try Self.bind(title, 3, s); try Self.bind(nil as String?, 4, s); try Self.bind(nil as String?, 5, s)
        guard sqlite3_step(s) == SQLITE_DONE else { throw FeedError.unavailable }; return subscription
    }
    public func subscriptions() throws -> [FeedSubscription] { try Self.readSubscriptions(connection.db) }
    @discardableResult
    public func removeSubscription(id: String) throws -> SubscriptionRemovalResult {
        let db = connection.db
        try Self.exec(db, "BEGIN IMMEDIATE")
        do {
            let affected = try Self.stringSet(db, "SELECT id FROM articles WHERE feed_id=?", id)
            let retained = try Self.stringSet(
                db, "SELECT a.id FROM articles a JOIN bookmarks b ON b.article_id=a.id WHERE a.feed_id=?", id
            )
            let deleted = affected.subtracting(retained)
            for sql in [
                "DELETE FROM translations WHERE article_id IN (SELECT a.id FROM articles a LEFT JOIN bookmarks b ON b.article_id=a.id WHERE a.feed_id=? AND b.article_id IS NULL)",
                "DELETE FROM articles WHERE feed_id=? AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.article_id=articles.id)",
                "DELETE FROM subscriptions WHERE id=?",
            ] {
                let statement = try Self.prepare(db, sql)
                defer { sqlite3_finalize(statement) }
                try Self.bind(id, 1, statement)
                guard sqlite3_step(statement) == SQLITE_DONE else { throw FeedError.unavailable }
            }
            if !deleted.isEmpty { beforeCommit?() }
            try Self.exec(db, "COMMIT")
            return SubscriptionRemovalResult(retainedArticleIDs: retained, deletedArticleIDs: deleted)
        } catch {
            try? Self.exec(db, "ROLLBACK")
            throw error
        }
    }

    /// Atomically records a successful fetch.  A failed fetch never calls this method,
    /// so previous snapshots and bookmarks remain untouched.
    public func saveFetchedFeed(_ feed: ParsedFeed, eTag: String? = nil, lastModified: String? = nil) throws {
        _ = try saveFetchedFeed(feed, eTag: eTag, lastModified: lastModified, requireExistingSubscription: false)
    }

    /// Saves a response only while its subscription still exists. This check and
    /// the write share one transaction, so a response racing with removal cannot
    /// recreate the subscription.
    @discardableResult
    public func saveFetchedFeedIfSubscribed(_ feed: ParsedFeed, eTag: String? = nil, lastModified: String? = nil) throws -> Bool {
        try saveFetchedFeed(feed, eTag: eTag, lastModified: lastModified, requireExistingSubscription: true)
    }

    private func saveFetchedFeed(_ feed: ParsedFeed, eTag: String?, lastModified: String?, requireExistingSubscription: Bool) throws -> Bool {
        let db = connection.db; try Self.exec(db, "BEGIN IMMEDIATE")
        do {
            let sub = try FeedSubscription(url: feed.sourceURL, title: feed.title, eTag: eTag, lastModified: lastModified)
            guard sub.id == feed.id, feed.articles.allSatisfy({ $0.feedID == feed.id }) else { throw FeedError.corrupted }
            if requireExistingSubscription,
               try Self.scalarInt(db, "SELECT count(*) FROM subscriptions WHERE id=?", sub.id) == 0 {
                try Self.exec(db, "ROLLBACK")
                return false
            }
            let ss = try Self.prepare(db, "INSERT INTO subscriptions(id,url,title,etag,last_modified) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,etag=excluded.etag,last_modified=excluded.last_modified")
            try Self.bind(sub.id, 1, ss); try Self.bind(sub.url.absoluteString, 2, ss); try Self.bind(feed.title, 3, ss); try Self.bind(eTag, 4, ss); try Self.bind(lastModified, 5, ss); guard sqlite3_step(ss) == SQLITE_DONE else { sqlite3_finalize(ss); throw FeedError.unavailable }; sqlite3_finalize(ss)
            for article in feed.articles { try save(article, db: db) }
            for article in feed.articles { try FeedArticleSearchIndex.reindex(articleID: article.id, on: db) }
            if !feed.articles.isEmpty { beforeCommit?() }
            try Self.exec(db, "COMMIT")
            return true
        } catch { try? Self.exec(db, "ROLLBACK"); throw error }
    }
    public func articles(feedID: String? = nil, limit: Int = 200) throws -> [FeedArticle] { try readArticles(feedID: feedID, bookmarked: nil, limit: limit) }
    public func bookmarkedArticles(limit: Int = 200) throws -> [FeedArticle] { try readArticles(feedID: nil, bookmarked: true, limit: limit) }
    public func isBookmarked(articleID: String) throws -> Bool { try Self.scalarInt(connection.db, "SELECT count(*) FROM bookmarks WHERE article_id=?", articleID) > 0 }
    @discardableResult public func toggleBookmark(articleID: String) throws -> Bool {
        let desired = !(try isBookmarked(articleID: articleID))
        try setBookmarked(articleID: articleID, bookmarked: desired)
        return desired
    }
    @discardableResult
    public func setBookmarked(articleID: String, bookmarked: Bool) throws -> BookmarkMutationResult {
        let db = connection.db
        try Self.exec(db, "BEGIN IMMEDIATE")
        do {
            let articleExists = try Self.scalarInt(db, "SELECT count(*) FROM articles WHERE id=?", articleID) == 1
            if !articleExists {
                guard !bookmarked else { throw FeedError.articleNotFound }
                try Self.exec(db, "COMMIT")
                return .articleDeleted
            }
            let statements = bookmarked
                ? ["INSERT INTO bookmarks(article_id) VALUES(?) ON CONFLICT(article_id) DO NOTHING"]
                : [
                    "DELETE FROM bookmarks WHERE article_id=?",
                    "DELETE FROM translations WHERE article_id=? AND NOT EXISTS (SELECT 1 FROM articles a JOIN subscriptions s ON s.id=a.feed_id WHERE a.id=?)",
                    "DELETE FROM articles WHERE id=? AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id=articles.feed_id)",
                ]
            for sql in statements {
                let statement = try Self.prepare(db, sql)
                defer { sqlite3_finalize(statement) }
                for index in 1 ... sqlite3_bind_parameter_count(statement) {
                    try Self.bind(articleID, index, statement)
                }
                guard sqlite3_step(statement) == SQLITE_DONE else { throw FeedError.unavailable }
            }
            let result: BookmarkMutationResult = try Self.scalarInt(
                db, "SELECT count(*) FROM articles WHERE id=?", articleID
            ) == 1 ? .articleRetained : .articleDeleted
            if result == .articleDeleted { beforeCommit?() }
            try Self.exec(db, "COMMIT")
            return result
        } catch {
            try? Self.exec(db, "ROLLBACK")
            throw error
        }
    }
    public func saveTranslation(_ translation: ArticleTranslation) throws {
        let db = connection.db
        // Reserve the write before checking the source. Other scenes own separate
        // connections, so actor isolation alone cannot protect this comparison.
        try Self.exec(db, "BEGIN IMMEDIATE")
        do {
            let article = try article(id: translation.articleID)
            guard article.sourceFingerprint == translation.sourceFingerprint else { throw FeedError.staleTranslation }
            let s = try Self.prepare(db, "INSERT INTO translations(article_id,source_fingerprint,target_language,title,body) VALUES(?,?,?,?,?) ON CONFLICT(article_id,target_language) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,title=excluded.title,body=excluded.body")
            defer { sqlite3_finalize(s) }
            try Self.bind(translation.articleID, 1, s)
            try Self.bind(translation.sourceFingerprint, 2, s)
            try Self.bind(translation.targetLanguage, 3, s)
            try Self.bind(translation.title, 4, s)
            try Self.bind(translation.body, 5, s)
            guard sqlite3_step(s) == SQLITE_DONE else { throw FeedError.unavailable }
            if translation.targetLanguage == "ja" {
                try FeedArticleSearchIndex.reindex(articleID: translation.articleID, on: db)
            }
            beforeCommit?()
            try Self.exec(db, "COMMIT")
        } catch {
            try? Self.exec(db, "ROLLBACK")
            throw error
        }
    }
    public func translation(articleID: String, targetLanguage: String) throws -> ArticleTranslation? {
        // Read the article source and cached translation with one statement. A
        // second connection therefore cannot change the source between two
        // independently committed SELECTs and make a stale cache row look fresh.
        let s = try Self.prepare(connection.db, "SELECT a.title,a.summary,a.content,t.source_fingerprint,t.title,t.body FROM articles a LEFT JOIN translations t ON t.article_id=a.id AND t.target_language=? WHERE a.id=?")
        defer { sqlite3_finalize(s) }
        try Self.bind(targetLanguage, 1, s)
        try Self.bind(articleID, 2, s)
        switch sqlite3_step(s) {
        case SQLITE_DONE: throw FeedError.articleNotFound
        case SQLITE_ROW:
            guard sqlite3_column_type(s, 3) != SQLITE_NULL else { return nil }
            let sourceTitle = try Self.text(s, 0)
            let summary = try Self.text(s, 1)
            let content = try Self.text(s, 2)
            let fingerprint = FeedDigest.hex(sourceTitle + "\u{0}" + (content.isEmpty ? summary : content))
            let cachedFingerprint = try Self.text(s, 3)
            guard cachedFingerprint == fingerprint else { return nil }
            return ArticleTranslation(articleID: articleID, sourceFingerprint: cachedFingerprint, targetLanguage: targetLanguage, title: try Self.text(s, 4), body: try Self.text(s, 5))
        default: throw FeedError.corrupted
        }
    }

    private func article(id: String) throws -> FeedArticle { guard let found = try readArticles(id: id).first else { throw FeedError.articleNotFound }; return found }
    private func save(_ a: FeedArticle, db: OpaquePointer) throws {
        let s = try Self.prepare(db, "INSERT INTO articles(id,feed_id,remote_id,title,url,summary,content,published) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET remote_id=excluded.remote_id,title=excluded.title,url=excluded.url,summary=excluded.summary,content=excluded.content,published=excluded.published")
        defer { sqlite3_finalize(s) }; try Self.bind(a.id, 1, s); try Self.bind(a.feedID, 2, s); try Self.bind(a.remoteID, 3, s); try Self.bind(a.title, 4, s); try Self.bind(a.url?.absoluteString, 5, s); try Self.bind(a.summary, 6, s); try Self.bind(a.content, 7, s); try Self.bind(a.publishedAt?.timeIntervalSinceReferenceDate, 8, s); guard sqlite3_step(s) == SQLITE_DONE else { throw FeedError.unavailable }
    }
    private func readArticles(feedID: String? = nil, bookmarked: Bool? = nil, limit: Int = 200, id: String? = nil) throws -> [FeedArticle] {
        let columns = "a.id,a.feed_id,a.remote_id,a.title,a.url,a.summary,a.content,a.published"
        let boundedLimit = max(0, min(limit, 2_000))
        let sql: String
        var values: [String] = []
        if bookmarked == true {
            // Select only indexed metadata until the bound is reached, then
            // materialize the potentially large article bodies for those rows.
            sql = "SELECT \(columns) FROM (SELECT a.id,a.published FROM articles a JOIN bookmarks b ON b.article_id=a.id ORDER BY a.published DESC,a.id ASC LIMIT ?) selected JOIN articles a ON a.id=selected.id ORDER BY selected.published DESC,selected.id ASC"
        } else {
            var predicates: [String] = []
            if let feedID { predicates.append("a.feed_id=?"); values.append(feedID) }
            if let id { predicates.append("a.id=?"); values.append(id) }
            let whereClause = predicates.isEmpty ? "" : " WHERE " + predicates.joined(separator: " AND ")
            sql = "SELECT \(columns) FROM articles a\(whereClause) ORDER BY a.published DESC,a.id ASC LIMIT ?"
        }
        let s = try Self.prepare(connection.db, sql)
        defer { sqlite3_finalize(s) }
        for (offset, value) in values.enumerated() { try Self.bind(value, Int32(offset + 1), s) }
        guard sqlite3_bind_int64(s, Int32(values.count + 1), Int64(boundedLimit)) == SQLITE_OK else { throw FeedError.unavailable }
        var result: [FeedArticle] = []
        result.reserveCapacity(boundedLimit)
        while true {
            switch sqlite3_step(s) {
            case SQLITE_ROW: result.append(try Self.article(s))
            case SQLITE_DONE: return result
            default: throw FeedError.corrupted
            }
        }
    }
    private static func article(_ s: OpaquePointer) throws -> FeedArticle {
        let rawURL = try optionalText(s, 4)
        let url: URL?
        if let rawURL {
            guard let parsed = URL(string: rawURL) else { throw FeedError.corrupted }
            url = parsed
        } else { url = nil }
        let published: Date?
        switch sqlite3_column_type(s, 7) {
        case SQLITE_NULL: published = nil
        case SQLITE_FLOAT, SQLITE_INTEGER:
            let seconds = sqlite3_column_double(s, 7)
            guard seconds.isFinite else { throw FeedError.corrupted }
            published = Date(timeIntervalSinceReferenceDate: seconds)
        default: throw FeedError.corrupted
        }
        return FeedArticle(id: try text(s, 0), feedID: try text(s, 1), remoteID: try optionalText(s, 2), title: try text(s, 3), url: url, summary: try text(s, 5), content: try text(s, 6), publishedAt: published)
    }
    private static func readSubscriptions(_ db: OpaquePointer) throws -> [FeedSubscription] {
        let s = try prepare(db, "SELECT id,url,title,etag,last_modified FROM subscriptions ORDER BY url")
        defer { sqlite3_finalize(s) }
        var result: [FeedSubscription] = []
        while true {
            switch sqlite3_step(s) {
            case SQLITE_DONE: return result
            case SQLITE_ROW:
                let storedID = try text(s, 0)
                guard let url = URL(string: try text(s, 1)) else { throw FeedError.corrupted }
                let subscription = try FeedSubscription(url: url, title: try optionalText(s, 2), eTag: try optionalText(s, 3), lastModified: try optionalText(s, 4))
                guard subscription.id == storedID else { throw FeedError.corrupted }
                result.append(subscription)
            default: throw FeedError.corrupted
            }
        }
    }

    private static func stringSet(_ db: OpaquePointer, _ sql: String, _ value: String) throws -> Set<String> {
        let statement = try prepare(db, sql)
        defer { sqlite3_finalize(statement) }
        try bind(value, 1, statement)
        var values: Set<String> = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW: values.insert(try text(statement, 0))
            case SQLITE_DONE: return values
            default: throw FeedError.corrupted
            }
        }
    }
    private static let schema = "CREATE TABLE subscriptions(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT,etag TEXT,last_modified TEXT);CREATE TABLE articles(id TEXT PRIMARY KEY,feed_id TEXT NOT NULL,remote_id TEXT,title TEXT NOT NULL,url TEXT,summary TEXT NOT NULL,content TEXT NOT NULL,published REAL);CREATE INDEX articles_feed_published ON articles(feed_id,published);CREATE TABLE bookmarks(article_id TEXT PRIMARY KEY REFERENCES articles(id));CREATE TABLE translations(article_id TEXT NOT NULL REFERENCES articles(id),source_fingerprint TEXT NOT NULL,target_language TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(article_id,target_language));PRAGMA user_version=1;"
    private struct ReadIndexColumn: Hashable, Sendable { let name: String; let descending: Bool }
    private struct ReadIndex: Sendable {
        let name: String
        let columns: [ReadIndexColumn]
        let definition: String
    }
    private static let readIndexes = [
        ReadIndex(
            name: "articles_published_id",
            columns: [ReadIndexColumn(name: "published", descending: true), ReadIndexColumn(name: "id", descending: false)],
            definition: "ON articles(published DESC,id ASC)"
        ),
        ReadIndex(
            name: "articles_feed_published_id",
            columns: [ReadIndexColumn(name: "feed_id", descending: false), ReadIndexColumn(name: "published", descending: true), ReadIndexColumn(name: "id", descending: false)],
            definition: "ON articles(feed_id,published DESC,id ASC)"
        ),
    ]
    private static func hasRequiredReadIndexes(_ db: OpaquePointer) throws -> Bool {
        let installed = try installedReadIndexes(db)
        return readIndexes.allSatisfy { required in installed.contains(required.columns) }
    }
    private static func installMissingReadIndexes(_ db: OpaquePointer) throws {
        let installed = try installedReadIndexes(db)
        var names = try schemaObjectNames(db)
        for required in readIndexes where !installed.contains(required.columns) {
            var name = required.name
            var suffix = 1
            while names.contains(sqliteASCIIIdentifier(name)) {
                name = "\(required.name)_query_v1_\(suffix)"
                suffix += 1
            }
            try exec(db, "CREATE INDEX IF NOT EXISTS \(name) \(required.definition)")
            names.insert(sqliteASCIIIdentifier(name))
        }
        guard try hasRequiredReadIndexes(db) else { throw FeedError.corrupted }
    }
    private static func schemaObjectNames(_ db: OpaquePointer) throws -> Set<String> {
        let statement = try prepare(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view','index')")
        defer { sqlite3_finalize(statement) }
        var names: Set<String> = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW: names.insert(sqliteASCIIIdentifier(try text(statement, 0)))
            case SQLITE_DONE: return names
            default: throw FeedError.corrupted
            }
        }
    }
    private static func sqliteASCIIIdentifier(_ name: String) -> String {
        String(decoding: name.utf8.map { byte in
            (65 ... 90).contains(byte) ? byte + 32 : byte
        }, as: UTF8.self)
    }
    private static func installedReadIndexes(_ db: OpaquePointer) throws -> Set<[ReadIndexColumn]> {
        let indexes = try prepare(db, "PRAGMA index_list(articles)")
        defer { sqlite3_finalize(indexes) }
        var installed: Set<[ReadIndexColumn]> = []
        while true {
            switch sqlite3_step(indexes) {
            case SQLITE_ROW:
                guard sqlite3_column_type(indexes, 2) == SQLITE_INTEGER,
                      sqlite3_column_type(indexes, 4) == SQLITE_INTEGER else { throw FeedError.corrupted }
                guard sqlite3_column_int(indexes, 2) == 0, sqlite3_column_int(indexes, 4) == 0 else { continue }
                let name = try text(indexes, 1)
                if let definition = try readIndexColumns(db, name: name) { installed.insert(definition) }
            case SQLITE_DONE: return installed
            default: throw FeedError.corrupted
            }
        }
    }
    private static func readIndexColumns(_ db: OpaquePointer, name: String) throws -> [ReadIndexColumn]? {
        let statement = try prepare(db, "SELECT name, \"desc\", coll, key FROM pragma_index_xinfo(?) ORDER BY seqno")
        defer { sqlite3_finalize(statement) }
        try bind(name, 1, statement)
        var definition: [ReadIndexColumn] = []
        var usable = true
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW:
                guard sqlite3_column_type(statement, 3) == SQLITE_INTEGER else { throw FeedError.corrupted }
                guard sqlite3_column_int(statement, 3) == 1 else { continue }
                guard sqlite3_column_type(statement, 0) == SQLITE_TEXT,
                      sqlite3_column_type(statement, 1) == SQLITE_INTEGER,
                      sqlite3_column_type(statement, 2) == SQLITE_TEXT,
                      try text(statement, 2).uppercased() == "BINARY" else {
                    usable = false
                    continue
                }
                definition.append(ReadIndexColumn(name: try text(statement, 0), descending: sqlite3_column_int(statement, 1) != 0))
            case SQLITE_DONE: return usable ? definition : nil
            default: throw FeedError.corrupted
            }
        }
    }
    private struct Column: Equatable { let name: String; let type: String; let notNull: Bool; let primaryKey: Int }
    private static func validateSchema(_ db: OpaquePointer) throws {
        let expected: [(String, [Column])] = [
            ("subscriptions", [Column(name:"id",type:"TEXT",notNull:false,primaryKey:1),Column(name:"url",type:"TEXT",notNull:true,primaryKey:0),Column(name:"title",type:"TEXT",notNull:false,primaryKey:0),Column(name:"etag",type:"TEXT",notNull:false,primaryKey:0),Column(name:"last_modified",type:"TEXT",notNull:false,primaryKey:0)]),
            ("articles", [Column(name:"id",type:"TEXT",notNull:false,primaryKey:1),Column(name:"feed_id",type:"TEXT",notNull:true,primaryKey:0),Column(name:"remote_id",type:"TEXT",notNull:false,primaryKey:0),Column(name:"title",type:"TEXT",notNull:true,primaryKey:0),Column(name:"url",type:"TEXT",notNull:false,primaryKey:0),Column(name:"summary",type:"TEXT",notNull:true,primaryKey:0),Column(name:"content",type:"TEXT",notNull:true,primaryKey:0),Column(name:"published",type:"REAL",notNull:false,primaryKey:0)]),
            ("bookmarks", [Column(name:"article_id",type:"TEXT",notNull:false,primaryKey:1)]),
            ("translations", [Column(name:"article_id",type:"TEXT",notNull:true,primaryKey:1),Column(name:"source_fingerprint",type:"TEXT",notNull:true,primaryKey:0),Column(name:"target_language",type:"TEXT",notNull:true,primaryKey:2),Column(name:"title",type:"TEXT",notNull:true,primaryKey:0),Column(name:"body",type:"TEXT",notNull:true,primaryKey:0)])
        ]
        for (table, required) in expected {
            let statement = try prepare(db, "PRAGMA table_info(\(table))")
            defer { sqlite3_finalize(statement) }
            var actual: [Column] = []
            columns: while true {
                switch sqlite3_step(statement) {
                case SQLITE_ROW:
                    guard sqlite3_column_type(statement, 3) == SQLITE_INTEGER,
                          sqlite3_column_type(statement, 5) == SQLITE_INTEGER else { throw FeedError.corrupted }
                    actual.append(Column(name: try text(statement, 1), type: try text(statement, 2).uppercased(), notNull: sqlite3_column_int64(statement, 3) == 1, primaryKey: Int(sqlite3_column_int64(statement, 5))))
                case SQLITE_DONE:
                    guard actual == required else { throw FeedError.corrupted }
                    break columns
                default: throw FeedError.corrupted
                }
            }
        }
    }
    private static func exec(_ db: OpaquePointer, _ sql: String) throws { guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw FeedError.unavailable } }
    private static func prepare(_ db: OpaquePointer, _ sql: String) throws -> OpaquePointer { var s:OpaquePointer?; guard sqlite3_prepare_v2(db, sql, -1, &s, nil) == SQLITE_OK, let s else { throw FeedError.corrupted }; return s }
    private static func scalarText(_ db: OpaquePointer, _ sql: String) throws -> String { let s=try prepare(db,sql); defer{sqlite3_finalize(s)}; guard sqlite3_step(s)==SQLITE_ROW else {throw FeedError.corrupted}; return try text(s,0) }
    private static func scalarInteger(_ db: OpaquePointer, _ sql: String) throws -> Int { let s=try prepare(db,sql); defer{sqlite3_finalize(s)}; guard sqlite3_step(s)==SQLITE_ROW, sqlite3_column_type(s,0)==SQLITE_INTEGER else {throw FeedError.corrupted}; return Int(sqlite3_column_int64(s,0)) }
    private static func scalarInt(_ db: OpaquePointer, _ sql: String, _ value: String) throws -> Int64 { let s=try prepare(db,sql); defer{sqlite3_finalize(s)}; try bind(value,1,s); guard sqlite3_step(s)==SQLITE_ROW, sqlite3_column_type(s,0)==SQLITE_INTEGER else {throw FeedError.corrupted}; return sqlite3_column_int64(s,0) }
    private static func text(_ s: OpaquePointer, _ i: Int32) throws -> String { guard sqlite3_column_type(s,i)==SQLITE_TEXT, let p=sqlite3_column_text(s,i) else {throw FeedError.corrupted}; return String(cString:p) }
    private static func optionalText(_ s: OpaquePointer, _ i: Int32) throws -> String? { sqlite3_column_type(s,i)==SQLITE_NULL ? nil : try text(s,i) }
    private static func bind(_ value: String?, _ i: Int32, _ s: OpaquePointer) throws { guard let value else { guard sqlite3_bind_null(s,i)==SQLITE_OK else {throw FeedError.unavailable}; return }; let transient=unsafeBitCast(-1,to:sqlite3_destructor_type.self); guard value.withCString({sqlite3_bind_text(s,i,$0,-1,transient)})==SQLITE_OK else {throw FeedError.unavailable} }
    private static func bind(_ value: Double?, _ i: Int32, _ s: OpaquePointer) throws { guard let value else { try bind(nil as String?,i,s); return }; guard sqlite3_bind_double(s,i,value)==SQLITE_OK else {throw FeedError.unavailable} }
}

private enum FeedURL {
    static func feedURL(_ url: URL) throws -> URL {
        guard var parts = URLComponents(url: url.absoluteURL, resolvingAgainstBaseURL: true),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil else { throw FeedError.invalidFeedURL }
        parts.scheme = "https"
        parts.host = host.lowercased()
        if parts.port == 443 { parts.port = nil }
        parts.fragment = nil
        if parts.path.isEmpty { parts.path = "/" }
        guard let canonical = parts.url else { throw FeedError.invalidFeedURL }
        return canonical
    }
}
enum FeedDigest { static func hex(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() } }
private enum FeedDate {
    static func parse(_ text: String?) -> Date? {
        guard let text = text?.trimmingCharacters(in:.whitespacesAndNewlines), !text.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let iso = ISO8601DateFormatter()
        if let date = iso.date(from: text) { return date }
        for format in ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEE, dd MMM yyyy HH:mm zzz", "dd MMM yyyy HH:mm:ss zzz"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = format
            if let date = formatter.date(from: text) { return date }
        }
        return nil
    }
}
private enum FeedHTML {
    static func plainText(_ value: String) -> String {
        normalizeWhitespace(decodeEntities(in: textWithMarkupRemoved(value)))
    }

    /// Removes only recognized HTML elements. Unknown angle-bracket text is
    /// escaped before entity decoding so code such as `<T>` remains visible.
    /// Tag ends are scanned with quote awareness, so `>` inside an attribute
    /// cannot truncate the element and discard following text.
    private static func textWithMarkupRemoved(_ source: String) -> String {
        var output = ""
        output.reserveCapacity(source.utf8.count)
        var index = source.startIndex
        var noRemainingCommentEnd = false
        while index < source.endIndex {
            guard source[index] == "<" else {
                output.append(source[index])
                index = source.index(after: index)
                continue
            }
            if source[index...].hasPrefix("<!--"), !noRemainingCommentEnd {
                if let end = source[index...].range(of: "-->")?.upperBound {
                    output.append(" ")
                    index = end
                    continue
                }
                // A failed search proves that no later comment opener can
                // have a terminator either; do not rescan this suffix.
                noRemainingCommentEnd = true
            }
            guard let end = tagEnd(in: source, after: index) else {
                // `tagEnd` has already established that the whole remaining
                // suffix is literal text. Append it once instead of scanning
                // that same suffix again for every later `<`.
                output.append(contentsOf: source[index...])
                break
            }
            let interiorStart = source.index(after: index)
            let interior = String(source[interiorStart ..< end])
            if let name = tagName(interior), htmlElements.contains(name) {
                if blockElements.contains(name) { output.append("\n") }
            } else {
                output += "&lt;" + interior + "&gt;"
            }
            index = source.index(after: end)
        }
        return output
    }

    private static func tagEnd(in source: String, after opening: String.Index) -> String.Index? {
        var index = source.index(after: opening)
        var quote: Character?
        while index < source.endIndex {
            let character = source[index]
            if let currentQuote = quote {
                if character == currentQuote { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == ">" {
                return index
            }
            index = source.index(after: index)
        }
        return nil
    }

    private static func tagName(_ interior: String) -> String? {
        let trimmed = interior.trimmingCharacters(in: .whitespacesAndNewlines)
        var text = trimmed[...]
        if text.first == "/" { text = text.dropFirst().drop(while: { $0.isWhitespace }) }
        guard let first = text.first, first.isASCII, first.isLetter else { return nil }
        let name = text.prefix { $0.isASCII && ($0.isLetter || $0.isNumber) }
        guard !name.isEmpty else { return nil }
        return name.lowercased()
    }

    /// Decodes references from the original input in one pass. Replacements
    /// are appended directly and are never scanned again, so `&amp;copy;`
    /// remains `&copy;` rather than being decoded twice.
    private static func decodeEntities(in source: String) -> String {
        var output = ""
        output.reserveCapacity(source.count)
        var index = source.startIndex
        while index < source.endIndex {
            guard source[index] == "&" else {
                output.append(source[index])
                index = source.index(after: index)
                continue
            }

            var end = source.index(after: index)
            var length = 0
            while end < source.endIndex, source[end] != ";", length < 64 {
                end = source.index(after: end)
                length += 1
            }
            guard end < source.endIndex, source[end] == ";" else {
                output.append("&")
                index = source.index(after: index)
                continue
            }

            let start = source.index(after: index)
            let token = String(source[start ..< end])
            let replacement: String?
            if token.hasPrefix("#x") || token.hasPrefix("#X") {
                replacement = scalar(String(token.dropFirst(2)), radix: 16)
            } else if token.hasPrefix("#") {
                replacement = scalar(String(token.dropFirst()), radix: 10)
            } else {
                replacement = HTMLNamedEntities.values[token]
            }
            guard let replacement else {
                output.append("&")
                index = source.index(after: index)
                continue
            }
            output += replacement
            index = source.index(after: end)
        }
        return output
    }

    private static func scalar(_ digits: String, radix: Int) -> String? {
        guard !digits.isEmpty, let value = UInt32(digits, radix: radix),
              value != 0, let scalar = UnicodeScalar(value) else { return nil }
        return String(scalar)
    }

    private static let htmlElements: Set<String> = [
        "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo", "blockquote", "body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav", "noscript", "object", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select", "slot", "small", "source", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
    ]
    private static let blockElements: Set<String> = [
        "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
    ]

    static func normalizeWhitespace(_ source: String) -> String {
        source
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .replacingOccurrences(of: "[ \\t\\f\\r]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: " *\\n+ *", with: "\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
private extension Data {
    var xmlDeclarationError: FeedError? {
        let bytes = [UInt8](self)
        let unit: Int
        let littleEndian: Bool
        if bytes.starts(with: [0x00, 0x00, 0xFE, 0xFF]) { unit = 4; littleEndian = false }
        else if bytes.starts(with: [0xFF, 0xFE, 0x00, 0x00]) { unit = 4; littleEndian = true }
        else if bytes.starts(with: [0xFE, 0xFF]) { unit = 2; littleEndian = false }
        else if bytes.starts(with: [0xFF, 0xFE]) { unit = 2; littleEndian = true }
        else if bytes.starts(with: [0x00, 0x00, 0x00, 0x3C]) { unit = 4; littleEndian = false }
        else if bytes.starts(with: [0x3C, 0x00, 0x00, 0x00]) { unit = 4; littleEndian = true }
        else if bytes.count >= 4, bytes[0] == 0x00, bytes[1] == 0x3C, bytes[2] == 0x00 { unit = 2; littleEndian = false }
        else if bytes.count >= 4, bytes[0] == 0x3C, bytes[1] == 0x00, bytes[3] == 0x00 { unit = 2; littleEndian = true }
        else { unit = 1; littleEndian = true }

        var ascii: [UInt8] = []
        ascii.reserveCapacity(bytes.count / unit)
        var offset = 0
        while offset + unit <= bytes.count {
            let scalar: UInt32
            switch (unit, littleEndian) {
            case (2, true): scalar = UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8
            case (2, false): scalar = UInt32(bytes[offset]) << 8 | UInt32(bytes[offset + 1])
            case (4, true):
                scalar = UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24
            case (4, false):
                scalar = UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16 | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3])
            default: scalar = UInt32(bytes[offset])
            }
            ascii.append(scalar <= 0x7F ? UInt8(scalar) : 0x80)
            offset += unit
        }

        func starts(_ token: [UInt8], at index: Int) -> Bool {
            index + token.count <= ascii.count && ascii[index ..< index + token.count].elementsEqual(token)
        }
        func declaration(_ token: [UInt8], at index: Int) -> Bool {
            guard starts(token, at: index) else { return false }
            guard index + token.count < ascii.count else { return false }
            return [0x09, 0x0A, 0x0D, 0x20, 0x25, 0x3E, 0x5B].contains(ascii[index + token.count])
        }
        func end(of token: [UInt8], after index: Int) -> Int? {
            guard index < ascii.count, token.count <= ascii.count - index else { return nil }
            for candidate in index ... ascii.count - token.count where starts(token, at: candidate) {
                return candidate + token.count
            }
            return nil
        }

        let comment = Array("<!--".utf8), commentEnd = Array("-->".utf8)
        let cdata = Array("<![CDATA[".utf8), cdataEnd = Array("]]>".utf8)
        let doctype = Array("<!DOCTYPE".utf8), entity = Array("<!ENTITY".utf8)
        var index = 0
        while index < ascii.count {
            if starts(comment, at: index) {
                guard let next = end(of: commentEnd, after: index + comment.count) else { return nil }
                index = next
            } else if starts(cdata, at: index) {
                guard let next = end(of: cdataEnd, after: index + cdata.count) else { return nil }
                index = next
            } else if declaration(doctype, at: index) || declaration(entity, at: index) {
                return .unsafeXML
            } else if starts(doctype, at: index) || starts(entity, at: index) {
                return .malformedXML
            } else {
                index += 1
            }
        }
        return nil
    }
}
