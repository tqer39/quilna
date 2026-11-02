import Foundation
import SwiftUI
import TextbookCore

@MainActor
final class ReaderModel: ObservableObject {
    let book = Textbook.introductory
    @Published var selectedPage: String? = Textbook.introductory.sections.first?.id
    @Published var selectedOption: String?
    @Published var feedback: AnswerAttempt?
    @Published var history: [AnswerAttempt] = []
    @Published var storageMessage = "回答履歴を準備しています。読書はそのまま利用できます。"
    @Published var isSaving = false
    private var store: (any AnswerHistoryStoring)?
    private var initialized = false
    private var answersByQuestion: [String: AnswerAttempt] = [:]
    private let dataDirectory: URL?

    init(dataDirectory: URL?, store: (any AnswerHistoryStoring)? = nil) {
        self.dataDirectory = dataDirectory
        self.store = store
    }

    var section: LearningSection? { book.sections.first { $0.id == selectedPage } }
    var isSaved: Bool { feedback.map { answer in history.contains { $0.id == answer.id } } ?? false }

    func initialize() async {
        guard !initialized else { return }
        initialized = true
        do {
            if let store {
                history = try await store.attempts(for: book)
                storageMessage = "回答履歴はこの端末に保存します。クラウド同期は未接続です。"
                return
            }
            let directory: URL
            if let dataDirectory { directory = dataDirectory }
            else {
                directory = try FileManager.default.url(
                    for: .applicationSupportDirectory, in: .userDomainMask,
                    appropriateFor: nil, create: true
                ).appendingPathComponent("TsumikiText", isDirectory: true)
            }
            let url = directory.appendingPathComponent("answers.sqlite")
            let opened = try await Task.detached(priority: .utility) { try HistoryStore(url: url) }.value
            let loaded = try await opened.attempts(for: book)
            store = opened
            history = loaded
            storageMessage = "回答履歴はこの端末に保存します。クラウド同期は未接続です。"
        } catch {
            storageMessage = error.localizedDescription + " 読書と問題への回答は利用できますが、回答を永続保存できません。"
        }
    }

    func changePage() {
        feedback = section.flatMap { answersByQuestion[$0.question.id] }
        selectedOption = feedback?.optionID
    }

    func submit() async {
        guard !isSaving, let question = section?.question, let selectedOption else { return }
        do {
            if feedback == nil {
                feedback = try book.answer(questionID: question.id, optionID: selectedOption)
                answersByQuestion[question.id] = feedback
            }
            await saveFeedback()
        } catch { storageMessage = error.localizedDescription }
    }

    func saveFeedback() async {
        guard !isSaving, let answer = feedback else { return }
        isSaving = true
        defer { isSaving = false }
        guard let store else {
            storageMessage = "この回答は未保存です。読書・回答は続けられます。保存先の問題を解消し、アプリを開き直してください。"
            return
        }
        do {
            try await store.save(answer, for: book)
            history = try await store.attempts(for: book)
            storageMessage = "回答をこの端末に保存しました。"
        } catch {
            storageMessage = error.localizedDescription + " 保存中だった回答は画面内に保持しています。対象の節で再試行できます。"
        }
    }

    func tryAgain() {
        if let questionID = section?.question.id { answersByQuestion[questionID] = nil }
        selectedOption = nil
        feedback = nil
    }
}

public struct TextbookReaderView: View {
    @StateObject private var model: ReaderModel

    public init(dataDirectory: URL? = nil) {
        _model = StateObject(wrappedValue: ReaderModel(dataDirectory: dataDirectory))
    }

    public var body: some View {
        NavigationSplitView {
            List(selection: $model.selectedPage) {
                Section("共通の教科書") {
                    ForEach(model.book.sections) { section in
                        NavigationLink(value: section.id) {
                            Label(section.title, systemImage: "book.closed")
                        }
                            .tag(section.id)
                            .accessibilityIdentifier("chapter-" + section.id)
                    }
                }
                Section {
                    NavigationLink(value: "history") {
                        Label("回答履歴", systemImage: "clock")
                    }
                        .tag("history")
                        .accessibilityIdentifier("history-navigation")
                }
            }
            .navigationTitle("Quilna")
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    status
                    if model.selectedPage == "history" { history }
                    else if let section = model.section { lesson(section) }
                    else { Text("目次から学ぶ節を選んでください。") }
                    Divider()
                    Label(model.storageMessage, systemImage: "internaldrive")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("storage-status")
                        .textSelection(.enabled)
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .navigationTitle(model.selectedPage == "history" ? "回答履歴" : model.book.title)
        }
        .task { await model.initialize() }
        .onChange(of: model.selectedPage) { _, _ in model.changePage() }
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("オフラインで学べる固定教材")
                .font(.subheadline.bold())
            Text("固定教材と回答履歴はオフラインで利用できます。AI生成とクラウド同期は未接続です。")
                .font(.footnote)
            Text("教材 v\(model.book.version) ・3節 ・目安5〜10分")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func lesson(_ section: LearningSection) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(section.title).font(.title.bold()).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 6) {
                Text("この節の目標").font(.headline)
                Text(section.objective)
            }
            ForEach(Array(section.paragraphs.enumerated()), id: \.offset) { _, paragraph in
                Text(paragraph).lineSpacing(6).textSelection(.enabled)
            }
        }
        Divider()
        VStack(alignment: .leading, spacing: 14) {
            Text("理解を確かめる").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            Text("適切なものを1つ選んでください。正誤はこの問題への回答を示すもので、理解全体の判定ではありません。")
                .font(.footnote).foregroundStyle(.secondary)
            Text(section.question.prompt).font(.headline)
            ForEach(section.question.options) { option in
                Button {
                    model.selectedOption = option.id
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: model.selectedOption == option.id ? "largecircle.fill.circle" : "circle")
                        Text(option.text).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .disabled(model.feedback != nil)
                .accessibilityIdentifier("option-" + option.id)
                .accessibilityValue(model.selectedOption == option.id ? "選択中" : "未選択")
            }
            if let answer = model.feedback, let option = section.question.option(answer.optionID) {
                VStack(alignment: .leading, spacing: 10) {
                    Label(answer.isCorrect ? "この回答は正解です" : "この回答を見直しましょう", systemImage: answer.isCorrect ? "checkmark.circle" : "arrow.clockwise")
                        .font(.headline)
                    Text(option.explanation).lineSpacing(5)
                    Text(model.isSaved ? "端末に保存済み" : "未保存（画面内に保持）")
                        .font(.caption).bold()
                        .accessibilityIdentifier("answer-save-state")
                    if !model.isSaved {
                        Button("保存を再試行") { Task { await model.saveFeedback() } }
                            .disabled(model.isSaving)
                            .accessibilityIdentifier("retry-save")
                    }
                    Button("もう一度考える") { model.tryAgain() }
                        .disabled(model.isSaving || !model.isSaved)
                        .accessibilityIdentifier("try-again")
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("answer-feedback")
            } else {
                Button("答えを確認") { Task { await model.submit() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.selectedOption == nil || model.isSaving)
                    .accessibilityIdentifier("check-answer")
            }
        }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("この教材版の回答履歴").font(.title.bold()).accessibilityAddTraits(.isHeader)
            Text("教材 v\(model.book.version) ・\(model.history.count)件。以前の教材版の回答と混ぜて採点しません。")
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("history-count")
            if model.history.isEmpty {
                Text("保存された回答はまだありません。目次から節を選び、問題を考えてみてください。")
            }
            ForEach(model.history.reversed()) { answer in
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.book.question(answer.questionID)?.prompt ?? answer.questionID).font(.headline)
                    Text(model.book.question(answer.questionID)?.option(answer.optionID)?.text ?? answer.optionID)
                    Text(answer.isCorrect ? "この回答は正解" : "見直しが必要な回答")
                    Text(answer.answeredAt, format: .dateTime.year().month().day().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                }
                Divider()
            }
        }
    }
}
