import SwiftUI
import TextbookCore

public struct ReaderAppView: View {
    private let dataDirectory: URL?

    public init(dataDirectory: URL? = nil) {
        self.dataDirectory = dataDirectory
    }

    public var body: some View {
        TabView {
            FeedReaderView(dataDirectory: dataDirectory)
                .tabItem { Label("情報収集", systemImage: "newspaper") }
                .accessibilityIdentifier("information-tab")
            TextbookReaderView(dataDirectory: dataDirectory)
                .tabItem { Label("教科書", systemImage: "book.closed") }
                .accessibilityIdentifier("textbook-tab")
        }
    }
}

struct FeedReaderView: View {
    private enum Filter: Hashable {
        case all
        case bookmarks
        case feed(String)
    }

    @StateObject private var model: FeedReaderModel
    @Environment(\.scenePhase) private var scenePhase

    init(dataDirectory: URL?) {
        _model = StateObject(wrappedValue: FeedReaderModel(dataDirectory: dataDirectory))
    }

    var body: some View {
        NavigationSplitView {
            List(selection: filterSelection) {
                Section("表示") {
                    NavigationLink(value: Filter.all) {
                        Label("すべての記事", systemImage: "tray.full")
                    }
                    .accessibilityIdentifier("all-articles")
                    NavigationLink(value: Filter.bookmarks) {
                        Label("ブックマーク", systemImage: "bookmark")
                    }
                    .accessibilityIdentifier("bookmarked-articles")
                }
                Section("購読フィード") {
                    ForEach(model.subscriptions) { subscription in
                        NavigationLink(value: Filter.feed(subscription.id)) {
                            Label(subscription.title ?? subscription.url.host ?? subscription.url.absoluteString, systemImage: "dot.radiowaves.left.and.right")
                                .lineLimit(2)
                        }
                        .contextMenu {
                            Button("購読を削除", role: .destructive) {
                                Task { await model.remove(subscription) }
                            }
                        }
                        .accessibilityIdentifier("feed-" + subscription.id)
                    }
                }
            }
            .navigationTitle("情報収集")
        } content: {
            Group {
                if model.isLoading {
                    ProgressView("保存済み記事を読み込み中")
                } else if model.showsSearchResults && model.isSearching && model.searchResults.isEmpty {
                    ProgressView("すべての保存済み記事を検索中")
                        .accessibilityIdentifier("article-search-loading")
                } else if model.visibleArticles.isEmpty {
                    VStack {
                        ContentUnavailableView(
                            searchEmptyTitle,
                            systemImage: model.showsSearchResults ? "magnifyingglass" : (model.showsBookmarksOnly ? "bookmark" : "newspaper"),
                            description: Text(model.showsSearchResults ? (model.searchMessage ?? "検索条件を変えてお試しください。") : "フィードを追加して再読み込みしてください。")
                        )
                        if model.showsSearchResults && (model.searchFailed || model.searchPreparing) {
                            Button("検索を再試行") { model.retrySearch() }
                                .accessibilityIdentifier("article-search-retry")
                        }
                    }
                    .accessibilityIdentifier("article-search-empty")
                } else {
                    List(selection: $model.selectedArticleID) {
                        ForEach(model.visibleArticles) { article in
                            NavigationLink(value: article.id) {
                                VStack(alignment: .leading, spacing: 4) {
                                if let translation = model.searchResult(for: article.id)?.translation,
                                   !translation.title.isEmpty || !translation.body.isEmpty {
                                    if !translation.title.isEmpty {
                                        Text(translation.title).font(.headline).lineLimit(3)
                                    }
                                    Text("原文: " + (article.title.isEmpty ? "無題の記事" : article.title))
                                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                    if !translation.body.isEmpty {
                                        Text(translation.body).font(.callout).lineLimit(2)
                                    }
                                } else {
                                    Text(article.title.isEmpty ? "無題の記事" : article.title)
                                    .font(.headline).lineLimit(3)
                                    let preview = article.translationSourceBody.trimmingCharacters(in: .whitespacesAndNewlines)
                                    if model.showsSearchResults && !preview.isEmpty {
                                        Text(preview).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                HStack {
                                    Text(sourceName(for: article))
                                    if let date = article.publishedAt {
                                        Text(date, format: .dateTime.year().month().day())
                                    }
                                }
                                .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityIdentifier("article-" + article.id)
                        }
                        if model.showsSearchResults && model.canLoadMoreSearchResults {
                            Button("さらに50件を読み込む") { model.loadMoreSearchResults() }
                                .accessibilityIdentifier("article-search-load-more")
                        } else if model.isLoadingMoreSearchResults {
                            ProgressView("検索結果を読み込み中")
                                .accessibilityIdentifier("article-search-page-loading")
                        }
                    }
                }
            }
            .navigationTitle(model.showsBookmarksOnly ? "ブックマーク" : "記事")
            .searchable(text: $model.searchText, placement: searchFieldPlacement, prompt: model.isPreparingSearch ? "検索を準備中" : "原文・保存済み日本語訳を検索")
            .accessibilityIdentifier("article-search-field")
            .safeAreaInset(edge: .top) { controls }
        } detail: {
            if let article = model.selectedArticle {
                ArticleDetailView(article: article, model: model)
                    .id(article.id + "-" + article.sourceFingerprint)
            } else {
                ContentUnavailableView("記事を選択", systemImage: "doc.text")
            }
        }
        .task { await model.initialize() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh() } }
        }
    }

    private var filterSelection: Binding<Filter?> {
        Binding {
            if model.showsBookmarksOnly { return .bookmarks }
            if let feedID = model.selectedFeedID { return .feed(feedID) }
            return .all
        } set: { selection in
            guard let selection else { return }
            switch selection {
            case .all:
                model.showsBookmarksOnly = false
                model.selectedFeedID = nil
            case .bookmarks:
                model.showsBookmarksOnly = true
                model.selectedFeedID = nil
            case .feed(let feedID):
                model.showsBookmarksOnly = false
                model.selectedFeedID = feedID
            }
            // A filter choice is also an explicit request to return to the
            // article list on collapsed navigation.
            model.selectedArticleID = nil
        }
    }

    private var searchFieldPlacement: SearchFieldPlacement {
        #if os(iOS)
        .navigationBarDrawer(displayMode: .always)
        #else
        .automatic
        #endif
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("HTTPS フィード URL", text: $model.feedURL)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("feed-url")
                    .onSubmit { Task { await model.addEnteredFeed() } }
                Button("追加") { Task { await model.addEnteredFeed() } }
                    .disabled(model.feedURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("add-feed")
                Button { Task { await model.refresh() } } label: {
                    Label("再読み込み", systemImage: "arrow.clockwise")
                }
                .disabled(model.isRefreshing)
                .accessibilityIdentifier("refresh-feeds")
            }
            HStack {
                Button("Apple Developer ニュースを追加") { Task { await model.addStarterFeed() } }
                    .accessibilityIdentifier("add-apple-feed")
                if model.isRefreshing { ProgressView().controlSize(.small) }
                Text(model.message).font(.caption).foregroundStyle(.secondary)
            }
            if let preparationMessage = model.preparationMessage {
                HStack {
                    if model.preparationFailure == nil { ProgressView().controlSize(.small) }
                    Text(preparationMessage).font(.caption).foregroundStyle(.secondary)
                    if model.preparationFailure != nil {
                        Button("検索の準備を再試行") { Task { await model.startSearchPreparation() } }
                            .accessibilityIdentifier("article-index-retry")
                    }
                }
                .accessibilityIdentifier("article-index-progress")
            }
            if model.hasSearchQuery, let searchMessage = model.searchMessage {
                Text(searchMessage)
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    .accessibilityIdentifier("article-search-status")
            }
            ForEach(model.failureByFeed.keys.sorted(), id: \.self) { feedID in
                if let failure = model.failureByFeed[feedID] {
                    Text(failure).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                }
            }
        }
        .padding(10)
        .background(.bar)
    }

    private func sourceName(for article: FeedArticle) -> String {
        model.subscriptions.first { $0.id == article.feedID }?.title
            ?? model.subscriptions.first { $0.id == article.feedID }?.url.host
            ?? "保存済みフィード"
    }

    private var searchEmptyTitle: String {
        if model.showsSearchResults {
            if model.searchPreparing { return "検索索引を準備しています" }
            if model.searchFailed { return "検索できませんでした" }
            return "一致する記事はありません"
        }
        return model.showsBookmarksOnly ? "ブックマークはありません" : "記事はありません"
    }
}

private struct ArticleDetailView: View {
    let article: FeedArticle
    @ObservedObject var model: FeedReaderModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(article.title.isEmpty ? "無題の記事" : article.title)
                    .font(.title.bold()).textSelection(.enabled)
                if let date = article.publishedAt {
                    Text(date, format: .dateTime.year().month().day().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                }
                Label("フィードが提供した記事・要約です。元サイトの全文を取得したものではありません。", systemImage: "info.circle")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("原文").font(.title2.bold())
                Text(article.translationSourceBody)
                    .lineSpacing(5).textSelection(.enabled)
                    .accessibilityIdentifier("article-original")
                HStack {
                    let bookmarkState = model.bookmarkState(for: article)
                    Button {
                        guard let bookmarkState else { return }
                        Task { await model.setBookmark(!bookmarkState, article: article) }
                    } label: {
                        if let bookmarkState {
                            Label(bookmarkState ? "ブックマークを外す" : "ブックマーク", systemImage: bookmarkState ? "bookmark.fill" : "bookmark")
                        } else {
                            Label("ブックマーク状態を確認できません", systemImage: "bookmark.slash")
                        }
                    }
                    .disabled(bookmarkState == nil || model.bookmarkBusy.contains(article.id))
                    .accessibilityIdentifier("bookmark-article")
                    if let url = article.url {
                        Link("元の記事を開く", destination: url)
                            .accessibilityIdentifier("open-original")
                    }
                }
                Divider()
                TranslationPanel(article: article, model: model)
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .navigationTitle("記事")
    }
}
