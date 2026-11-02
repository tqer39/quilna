import SwiftUI
import TextbookUI

@main
struct QuilnaApp: App {
    private let dataDirectory: URL?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--data-directory"), arguments.indices.contains(index + 1) {
            dataDirectory = URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
        } else {
            dataDirectory = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            ReaderAppView(dataDirectory: dataDirectory)
                .frame(minWidth: 720, minHeight: 600)
        }
        .defaultSize(width: 1080, height: 780)
    }
}
