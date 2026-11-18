import Foundation
import CSQLite

enum FeedArticleSearchIndex {
    static let schemaVersion = 2
    static let normalizationVersion = 1
    private static let objectPrefix = "article_search_"
    private static let requiredObjects: Set<String> = [
        "article_search_metadata", "article_search_documents", "article_search_order",
        "article_search_documents_feed_order", "article_search_documents_order",
        "article_search_fts", "article_search_article_delete", "article_search_article_update",
        "article_search_translation_insert", "article_search_translation_update",
        "article_search_translation_delete",
    ]
    private static let shadowObjects: Set<String> = [
        "article_search_fts_data", "article_search_fts_idx",
        "article_search_fts_docsize", "article_search_fts_config",
    ]
    private static let installedObjects = requiredObjects.union(shadowObjects)

    private static let preparationTable = "article_search_preparation"
    private static let preparationSchema = "CREATE TABLE article_search_preparation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1),last_rowid INTEGER,processed INTEGER NOT NULL CHECK(processed>=0))"

    static func preflight(on db: OpaquePointer) throws {
        // Validation and the optional preparation marker must share a snapshot:
        // another scene can complete preparation while this connection opens.
        try exec(db, "BEGIN")
        do {
            try validateInstallation(db)
            try exec(db, "COMMIT")
        } catch {
            try? exec(db, "ROLLBACK")
            throw error
        }
    }

    private static func validateInstallation(_ db: OpaquePointer) throws {
        let objects = try schemaObjects(db)
        let reserved = Set(objects.filter { $0.hasPrefix(objectPrefix) })
        guard !reserved.isEmpty else { return }
        let versions = try metadataVersions(db)
        guard versions.1 == normalizationVersion else { throw FeedError.corrupted }
        if versions.0 == schemaVersion {
            guard reserved == installedObjects || reserved == installedObjects.union([preparationTable]) else {
                throw FeedError.corrupted
            }
            try validateSchema(db, version: schemaVersion)
            if reserved.contains(preparationTable) {
                guard try scalarText(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='article_search_preparation'") == preparationSchema else {
                    throw FeedError.corrupted
                }
                _ = try preparationCursor(db)
            }
        } else if versions.0 == 1 {
            guard reserved == installedObjects.subtracting(["article_search_documents_order"]) else {
                throw FeedError.corrupted
            }
            try validateSchema(db, version: 1)
        } else { throw FeedError.corrupted }
    }

    static func prepare(on db: OpaquePointer, deferred: Bool = false) throws {
        try preflight(on: db)
        // Ready v2 stores open without acquiring a write lock.
        if try schemaObjects(db).contains("article_search_metadata"),
           try metadataVersions(db).0 == schemaVersion {
            if !deferred {
                while try !preparationStatus(on: db).isReady { _ = try prepareBatch(on: db) }
            }
            return
        }
        try exec(db, "BEGIN IMMEDIATE")
        do {
            // Recheck under the write lock to coordinate simultaneous first opens.
            try validateInstallation(db)
            let objects = try schemaObjects(db)
            if !objects.contains("article_search_metadata") {
                try exec(db, schema)
                if deferred {
                    try exec(db, preparationSchema)
                    try exec(db, "INSERT INTO article_search_preparation VALUES(1,1,NULL,0)")
                } else { try backfill(db) }
            } else if try metadataVersions(db).0 == 1 {
                try exec(db, "CREATE UNIQUE INDEX article_search_documents_order ON article_search_documents(order_id)")
                try exec(db, "UPDATE article_search_metadata SET schema_version=2 WHERE singleton=1")
            }
            try exec(db, "COMMIT")
        } catch {
            try? exec(db, "ROLLBACK")
            throw error
        }
        if !deferred {
            while try !preparationStatus(on: db).isReady { _ = try prepareBatch(on: db) }
        }
    }

    static func preparationStatus(on db: OpaquePointer) throws -> ArticleSearchPreparation {
        // A read transaction also protects against another connection dropping
        // the marker between its existence check and the progress read.
        try exec(db, "BEGIN")
        do {
            let result: ArticleSearchPreparation
            if try schemaObjects(db).contains(preparationTable) {
                result = .preparing(processedArticles: try preparationCursor(db).processed)
            } else { result = .ready }
            try exec(db, "COMMIT")
            return result
        } catch {
            try? exec(db, "ROLLBACK")
            throw error
        }
    }

    private static func preparationCursor(_ db: OpaquePointer) throws -> (rowID: Int64?, processed: Int64) {
        let statement = try prepare(db, "SELECT last_rowid,processed FROM article_search_preparation WHERE singleton=1 AND version=1 AND (SELECT count(*) FROM article_search_preparation)=1")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              [SQLITE_NULL, SQLITE_INTEGER].contains(sqlite3_column_type(statement, 0)),
              sqlite3_column_type(statement, 1) == SQLITE_INTEGER,
              sqlite3_column_int64(statement, 1) >= 0 else { throw FeedError.corrupted }
        return (sqlite3_column_type(statement, 0) == SQLITE_NULL ? nil : sqlite3_column_int64(statement, 0),
                sqlite3_column_int64(statement, 1))
    }

    static func prepareBatch(on db: OpaquePointer) throws -> ArticleSearchPreparation {
        try Task.checkCancellation()
        try exec(db, "BEGIN IMMEDIATE")
        do {
            guard try schemaObjects(db).contains(preparationTable) else {
                try exec(db, "COMMIT")
                return .ready
            }
            let cursor = try preparationCursor(db)
            let sql = cursor.rowID == nil
                ? "SELECT rowid,id FROM articles ORDER BY rowid LIMIT 8"
                : "SELECT rowid,id FROM articles WHERE rowid>? ORDER BY rowid LIMIT 8"
            let select = try prepare(db, sql)
            var rows: [(Int64, String)] = []
            do {
                defer { sqlite3_finalize(select) }
                if let rowID = cursor.rowID {
                    guard sqlite3_bind_int64(select, 1, rowID) == SQLITE_OK else { throw FeedError.unavailable }
                }
                while true {
                    let step = sqlite3_step(select)
                    if step == SQLITE_DONE { break }
                    guard step == SQLITE_ROW else { throw FeedError.unavailable }
                    rows.append((sqlite3_column_int64(select, 0), try text(select, 1)))
                }
            }
            if rows.isEmpty {
                try exec(db, "DROP TABLE article_search_preparation")
                try exec(db, "COMMIT")
                return .ready
            }
            let clock = ContinuousClock()
            let start = clock.now
            var processed = cursor.processed
            for (rowID, articleID) in rows {
                try Task.checkCancellation()
                try reindex(articleID: articleID, on: db)
                processed += 1
                // Cursor and FTS writes commit together. A crash can only resume
                // from a fully committed batch. Each call releases the writer.
                try exec(db, "UPDATE article_search_preparation SET last_rowid=\(rowID),processed=\(processed) WHERE singleton=1")
                if start.duration(to: clock.now) >= .milliseconds(8) { break }
            }
            try Task.checkCancellation()
            try exec(db, "COMMIT")
            return .preparing(processedArticles: processed)
        } catch {
            try? exec(db, "ROLLBACK")
            throw error
        }
    }

    static func reindex(articleID: String, on db: OpaquePointer) throws {
        let statement = try prepare(db, """
            SELECT a.id,a.feed_id,a.title,a.summary,a.content,
                   t.source_fingerprint,t.title,t.body
            FROM articles a
            LEFT JOIN translations t ON t.article_id=a.id AND t.target_language='ja'
            WHERE a.id=?
            """)
        defer { sqlite3_finalize(statement) }
        try bind(articleID, 1, statement)
        guard sqlite3_step(statement) == SQLITE_ROW else { throw FeedError.articleNotFound }
        let sourceTitle = try text(statement, 2)
        let summary = try text(statement, 3)
        let content = try text(statement, 4)
        let fingerprint = FeedDigest.hex(sourceTitle + "\u{0}" + (content.isEmpty ? summary : content))
        let storedTranslationFingerprint = try optionalText(statement, 5)
        let freshJapanese = storedTranslationFingerprint == fingerprint
        let japaneseTitle: String
        let japaneseBody: String
        if freshJapanese {
            japaneseTitle = try optionalText(statement, 6) ?? ""
            japaneseBody = try optionalText(statement, 7) ?? ""
        } else {
            japaneseTitle = ""
            japaneseBody = ""
        }

        let document = try ensureDocument(
            articleID: try text(statement, 0), feedID: try text(statement, 1),
            sourceFingerprint: fingerprint, on: db
        )
        if document.indexed { try deleteFTSRow(document.orderID, on: db) }
        try exec(db, "INSERT INTO article_search_order DEFAULT VALUES")
        let orderID = sqlite3_last_insert_rowid(db)
        try exec(db, "DELETE FROM article_search_order")
        let fields = FeedSearchText.indexedFields([sourceTitle, summary, content, japaneseTitle, japaneseBody])
        let encoded = fields.long
        let short = fields.short
        let insert = try prepare(db, "INSERT INTO article_search_fts(rowid,original_title,original_summary,original_content,japanese_title,japanese_body,short_tokens) VALUES(?,?,?,?,?,?,?)")
        defer { sqlite3_finalize(insert) }
        guard sqlite3_bind_int64(insert, 1, orderID) == SQLITE_OK else { throw FeedError.unavailable }
        for (offset, value) in (encoded + [short]).enumerated() { try bind(value, Int32(offset + 2), insert) }
        guard sqlite3_step(insert) == SQLITE_DONE else { throw FeedError.unavailable }

        let update = try prepare(db, "UPDATE article_search_documents SET feed_id=?,source_fingerprint=?,indexed_source_fingerprint=?,order_id=? WHERE document_id=?")
        defer { sqlite3_finalize(update) }
        try bind(try text(statement, 1), 1, update)
        try bind(fingerprint, 2, update)
        try bind(fingerprint, 3, update)
        guard sqlite3_bind_int64(update, 4, orderID) == SQLITE_OK,
              sqlite3_bind_int64(update, 5, document.id) == SQLITE_OK,
              sqlite3_step(update) == SQLITE_DONE else { throw FeedError.unavailable }
    }

    private static func ensureDocument(articleID: String, feedID: String, sourceFingerprint: String,
                                       on db: OpaquePointer) throws -> (id: Int64, indexed: Bool, orderID: Int64) {
        let insert = try prepare(db, "INSERT INTO article_search_documents(article_id,feed_id,source_fingerprint,indexed_source_fingerprint,order_id) VALUES(?,?,?,NULL,0) ON CONFLICT(article_id) DO NOTHING")
        defer { sqlite3_finalize(insert) }
        try bind(articleID, 1, insert); try bind(feedID, 2, insert); try bind(sourceFingerprint, 3, insert)
        guard sqlite3_step(insert) == SQLITE_DONE else { throw FeedError.unavailable }
        let select = try prepare(db, "SELECT document_id,indexed_source_fingerprint,order_id FROM article_search_documents WHERE article_id=?")
        defer { sqlite3_finalize(select) }
        try bind(articleID, 1, select)
        guard sqlite3_step(select) == SQLITE_ROW else { throw FeedError.corrupted }
        return (sqlite3_column_int64(select, 0), sqlite3_column_type(select, 1) != SQLITE_NULL,
                sqlite3_column_int64(select, 2))
    }

    private static func deleteFTSRow(_ documentID: Int64, on db: OpaquePointer) throws {
        let statement = try prepare(db, "DELETE FROM article_search_fts WHERE rowid=?")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_bind_int64(statement, 1, documentID) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_DONE else { throw FeedError.unavailable }
    }

    private static func backfill(_ db: OpaquePointer) throws {
        let articles = try prepare(db, "SELECT id FROM articles ORDER BY rowid ASC")
        defer { sqlite3_finalize(articles) }
        while true {
            switch sqlite3_step(articles) {
            case SQLITE_ROW: try reindex(articleID: try text(articles, 0), on: db)
            case SQLITE_DONE: return
            default: throw FeedError.unavailable
            }
        }
    }

    private static func validateSchema(_ db: OpaquePointer, version: Int) throws {
        let ftsSQL = try scalarText(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='article_search_fts'").lowercased()
        guard ftsSQL.contains("contentless_delete=1"), ftsSQL.contains("detail=full"),
              ftsSQL.contains("tokenize='ascii'") else { throw FeedError.corrupted }
        let documentColumns = try columnNames(db, table: "article_search_documents")
        guard documentColumns == ["document_id", "article_id", "feed_id", "source_fingerprint", "indexed_source_fingerprint", "order_id"] else {
            throw FeedError.corrupted
        }
        guard try columnNames(db, table: "article_search_metadata") == ["singleton", "schema_version", "normalization_version"],
              try columnNames(db, table: "article_search_order") == ["order_id"],
              try columnNames(db, table: "article_search_fts") == ["original_title", "original_summary", "original_content", "japanese_title", "japanese_body", "short_tokens"],
              try columnNames(db, table: "article_search_fts_data") == ["id", "block"],
              try columnNames(db, table: "article_search_fts_idx") == ["segid", "term", "pgno"],
              try columnNames(db, table: "article_search_fts_docsize") == ["id", "sz", "origin"],
              try columnNames(db, table: "article_search_fts_config") == ["k", "v"] else {
            throw FeedError.corrupted
        }
        let documentsSQL = try scalarText(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='article_search_documents'").lowercased()
        let orderSQL = try scalarText(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='article_search_order'").lowercased()
        let indexSQL = try scalarText(db, "SELECT sql FROM sqlite_master WHERE type='index' AND name='article_search_documents_feed_order'").lowercased()
        let orderIndexSQL = version >= 2
            ? try scalarText(db, "SELECT sql FROM sqlite_master WHERE type='index' AND name='article_search_documents_order'").lowercased()
            : ""
        guard documentsSQL.contains("primary key autoincrement"), orderSQL.contains("primary key autoincrement"),
              documentsSQL.contains("article_id text not null unique"),
              documentsSQL.contains("indexed_source_fingerprint text"),
              indexSQL.contains("(feed_id,order_id desc)"),
              version < 2 || orderIndexSQL.contains("unique index article_search_documents_order")
                && orderIndexSQL.contains("(order_id)") else { throw FeedError.corrupted }
        for (name, definition) in requiredDefinitions where version >= 2 || name != "article_search_documents_order" {
            let actualType = try scalarText(db, "SELECT type FROM sqlite_master WHERE name='\(name)'")
            let actualSQL = try scalarText(db, "SELECT sql FROM sqlite_master WHERE name='\(name)'")
            guard actualType == definition.type, actualSQL == definition.sql else { throw FeedError.corrupted }
        }
    }

    private static let requiredDefinitions: [String: (type: String, sql: String)] = [
        "article_search_metadata": ("table", "CREATE TABLE article_search_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,normalization_version INTEGER NOT NULL)"),
        "article_search_documents": ("table", """
            CREATE TABLE article_search_documents(
              document_id INTEGER PRIMARY KEY AUTOINCREMENT,
              article_id TEXT NOT NULL UNIQUE,
              feed_id TEXT NOT NULL,
              source_fingerprint TEXT NOT NULL,
              indexed_source_fingerprint TEXT,
              order_id INTEGER NOT NULL
            )
            """),
        "article_search_documents_feed_order": ("index", "CREATE INDEX article_search_documents_feed_order ON article_search_documents(feed_id,order_id DESC)"),
        "article_search_documents_order": ("index", "CREATE UNIQUE INDEX article_search_documents_order ON article_search_documents(order_id)"),
        "article_search_order": ("table", "CREATE TABLE article_search_order(order_id INTEGER PRIMARY KEY AUTOINCREMENT)"),
        "article_search_fts": ("table", """
            CREATE VIRTUAL TABLE article_search_fts USING fts5(
              original_title,original_summary,original_content,japanese_title,japanese_body,short_tokens,
              content='',contentless_delete=1,detail=full,tokenize='ascii'
            )
            """),
        "article_search_fts_data": ("table", "CREATE TABLE 'article_search_fts_data'(id INTEGER PRIMARY KEY, block BLOB)"),
        "article_search_fts_idx": ("table", "CREATE TABLE 'article_search_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID"),
        "article_search_fts_docsize": ("table", "CREATE TABLE 'article_search_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB, origin INTEGER)"),
        "article_search_fts_config": ("table", "CREATE TABLE 'article_search_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID"),
        "article_search_article_delete": ("trigger", """
            CREATE TRIGGER article_search_article_delete BEFORE DELETE ON articles BEGIN
              DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.id AND indexed_source_fingerprint IS NOT NULL);
              DELETE FROM article_search_documents WHERE article_id=OLD.id;
            END
            """),
        "article_search_article_update": ("trigger", """
            CREATE TRIGGER article_search_article_update AFTER UPDATE ON articles BEGIN
              DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.id AND indexed_source_fingerprint IS NOT NULL);
              UPDATE article_search_documents SET feed_id=NEW.feed_id,indexed_source_fingerprint=NULL WHERE article_id=OLD.id AND NEW.id=OLD.id;
              DELETE FROM article_search_documents WHERE article_id=OLD.id AND NEW.id<>OLD.id;
            END
            """),
        "article_search_translation_insert": ("trigger", """
            CREATE TRIGGER article_search_translation_insert AFTER INSERT ON translations WHEN NEW.target_language='ja' BEGIN
              DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=NEW.article_id AND indexed_source_fingerprint IS NOT NULL);
              UPDATE article_search_documents SET indexed_source_fingerprint=NULL WHERE article_id=NEW.article_id;
            END
            """),
        "article_search_translation_update": ("trigger", """
            CREATE TRIGGER article_search_translation_update AFTER UPDATE ON translations WHEN OLD.target_language='ja' OR NEW.target_language='ja' BEGIN
              DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.article_id AND indexed_source_fingerprint IS NOT NULL);
              DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=NEW.article_id AND NEW.article_id<>OLD.article_id AND indexed_source_fingerprint IS NOT NULL);
              UPDATE article_search_documents SET indexed_source_fingerprint=NULL WHERE article_id IN (OLD.article_id,NEW.article_id);
            END
            """),
        "article_search_translation_delete": ("trigger", """
            CREATE TRIGGER article_search_translation_delete AFTER DELETE ON translations WHEN OLD.target_language='ja' BEGIN
              DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.article_id AND indexed_source_fingerprint IS NOT NULL);
              UPDATE article_search_documents SET indexed_source_fingerprint=NULL WHERE article_id=OLD.article_id;
            END
            """),
    ]

    private static func metadataVersions(_ db: OpaquePointer) throws -> (Int, Int) {
        let statement = try prepare(db, "SELECT schema_version,normalization_version FROM article_search_metadata WHERE singleton=1 AND (SELECT count(*) FROM article_search_metadata)=1")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, sqlite3_column_type(statement, 0) == SQLITE_INTEGER,
              sqlite3_column_type(statement, 1) == SQLITE_INTEGER else {
            throw FeedError.corrupted
        }
        return (Int(sqlite3_column_int64(statement, 0)), Int(sqlite3_column_int64(statement, 1)))
    }

    private static func schemaObjects(_ db: OpaquePointer) throws -> Set<String> {
        let statement = try prepare(db, "SELECT lower(name) FROM sqlite_master WHERE type IN ('table','view','index','trigger')")
        defer { sqlite3_finalize(statement) }
        var result: Set<String> = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW: result.insert(try text(statement, 0))
            case SQLITE_DONE: return result
            default: throw FeedError.corrupted
            }
        }
    }

    private static func columnNames(_ db: OpaquePointer, table: String) throws -> [String] {
        let statement = try prepare(db, "SELECT name FROM pragma_table_info(?) ORDER BY cid")
        defer { sqlite3_finalize(statement) }
        try bind(table, 1, statement)
        var result: [String] = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW: result.append(try text(statement, 0))
            case SQLITE_DONE: return result
            default: throw FeedError.corrupted
            }
        }
    }

    private static let schema = """
        CREATE TABLE article_search_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,normalization_version INTEGER NOT NULL);
        INSERT INTO article_search_metadata(singleton,schema_version,normalization_version) VALUES(1,2,1);
        CREATE TABLE article_search_documents(
          document_id INTEGER PRIMARY KEY AUTOINCREMENT,
          article_id TEXT NOT NULL UNIQUE,
          feed_id TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          indexed_source_fingerprint TEXT,
          order_id INTEGER NOT NULL
        );
        CREATE INDEX article_search_documents_feed_order ON article_search_documents(feed_id,order_id DESC);
        CREATE UNIQUE INDEX article_search_documents_order ON article_search_documents(order_id);
        CREATE TABLE article_search_order(order_id INTEGER PRIMARY KEY AUTOINCREMENT);
        CREATE VIRTUAL TABLE article_search_fts USING fts5(
          original_title,original_summary,original_content,japanese_title,japanese_body,short_tokens,
          content='',contentless_delete=1,detail=full,tokenize='ascii'
        );
        CREATE TRIGGER article_search_article_delete BEFORE DELETE ON articles BEGIN
          DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.id AND indexed_source_fingerprint IS NOT NULL);
          DELETE FROM article_search_documents WHERE article_id=OLD.id;
        END;
        CREATE TRIGGER article_search_article_update AFTER UPDATE ON articles BEGIN
          DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.id AND indexed_source_fingerprint IS NOT NULL);
          UPDATE article_search_documents SET feed_id=NEW.feed_id,indexed_source_fingerprint=NULL WHERE article_id=OLD.id AND NEW.id=OLD.id;
          DELETE FROM article_search_documents WHERE article_id=OLD.id AND NEW.id<>OLD.id;
        END;
        CREATE TRIGGER article_search_translation_insert AFTER INSERT ON translations WHEN NEW.target_language='ja' BEGIN
          DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=NEW.article_id AND indexed_source_fingerprint IS NOT NULL);
          UPDATE article_search_documents SET indexed_source_fingerprint=NULL WHERE article_id=NEW.article_id;
        END;
        CREATE TRIGGER article_search_translation_update AFTER UPDATE ON translations WHEN OLD.target_language='ja' OR NEW.target_language='ja' BEGIN
          DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.article_id AND indexed_source_fingerprint IS NOT NULL);
          DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=NEW.article_id AND NEW.article_id<>OLD.article_id AND indexed_source_fingerprint IS NOT NULL);
          UPDATE article_search_documents SET indexed_source_fingerprint=NULL WHERE article_id IN (OLD.article_id,NEW.article_id);
        END;
        CREATE TRIGGER article_search_translation_delete AFTER DELETE ON translations WHEN OLD.target_language='ja' BEGIN
          DELETE FROM article_search_fts WHERE rowid=(SELECT order_id FROM article_search_documents WHERE article_id=OLD.article_id AND indexed_source_fingerprint IS NOT NULL);
          UPDATE article_search_documents SET indexed_source_fingerprint=NULL WHERE article_id=OLD.article_id;
        END;
        """

    private static func exec(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw FeedError.unavailable }
    }
    private static func prepare(_ db: OpaquePointer, _ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw FeedError.corrupted }
        return statement
    }
    private static func scalarText(_ db: OpaquePointer, _ sql: String) throws -> String {
        let statement = try prepare(db, sql); defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw FeedError.corrupted }
        return try text(statement, 0)
    }
    private static func text(_ statement: OpaquePointer, _ column: Int32) throws -> String {
        guard sqlite3_column_type(statement, column) == SQLITE_TEXT,
              let bytes = sqlite3_column_text(statement, column) else { throw FeedError.corrupted }
        return String(cString: bytes)
    }
    private static func optionalText(_ statement: OpaquePointer, _ column: Int32) throws -> String? {
        sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : try text(statement, column)
    }
    private static func bind(_ value: String, _ index: Int32, _ statement: OpaquePointer) throws {
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard value.withCString({ sqlite3_bind_text(statement, index, $0, -1, transient) }) == SQLITE_OK else {
            throw FeedError.unavailable
        }
    }
}

enum FeedSearchText {
    static func normalizedScalars(_ value: String) -> [Unicode.Scalar] {
        let normalized = value.precomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping
        return normalized.unicodeScalars.map { scalar in
            if (65 ... 90).contains(scalar.value) { return Unicode.Scalar(scalar.value + 32)! }
            if (0x3041 ... 0x3096).contains(scalar.value) || (0x309D ... 0x309E).contains(scalar.value) {
                return Unicode.Scalar(scalar.value + 0x60)!
            }
            return scalar
        }
    }

    static func longTokens(_ value: String) -> String {
        longTokens(encodedScalars(value))
    }

    static func shortTokens(_ fields: [String]) -> String {
        shortTokens(fields.map(encodedScalars))
    }

    static func indexedFields(_ fields: [String]) -> (long: [String], short: String) {
        let encoded = fields.map(encodedScalars)
        return (encoded.map(longTokens), shortTokens(encoded))
    }

    private static func encodedScalars(_ value: String) -> [UInt32] {
        normalizedScalars(value).map(\.value)
    }

    private static func longTokens(_ scalars: [UInt32]) -> String {
        guard scalars.count >= 3 else { return "" }
        var bytes: [UInt8] = []
        bytes.reserveCapacity((scalars.count - 2) * 20)
        for index in 0 ... scalars.count - 3 {
            if !bytes.isEmpty { bytes.append(32) }
            bytes.append(116)
            appendHex(scalars[index], to: &bytes)
            appendHex(scalars[index + 1], to: &bytes)
            appendHex(scalars[index + 2], to: &bytes)
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func shortTokens(_ fields: [[UInt32]]) -> String {
        var tokens: Set<String> = []
        for scalars in fields {
            for scalar in scalars { tokens.insert(token(prefix: 117, scalars: [scalar])) }
            if scalars.count >= 2 {
                for index in 0 ... scalars.count - 2 {
                    tokens.insert(token(prefix: 98, scalars: [scalars[index], scalars[index + 1]]))
                }
            }
        }
        return tokens.sorted().joined(separator: " ")
    }

    static func matchExpression(_ input: String) throws -> String? {
        if input.unicodeScalars.contains(where: {
            $0.value == 0 || ($0.properties.generalCategory == .control && !$0.properties.isWhitespace)
        }) {
            throw ArticleSearchError.invalidQuery
        }
        if input.unicodeScalars.count > 4_096 { throw ArticleSearchError.queryTooLong }
        let scalars = normalizedScalars(input)
        if scalars.count > 128 { throw ArticleSearchError.queryTooLong }
        var terms: [[Unicode.Scalar]] = []
        var current: [Unicode.Scalar] = []
        for scalar in scalars {
            if scalar.properties.isWhitespace {
                if !current.isEmpty { terms.append(current); current = [] }
            } else { current.append(scalar) }
        }
        if !current.isEmpty { terms.append(current) }
        guard !terms.isEmpty else { return nil }
        guard terms.count <= 8 else { throw ArticleSearchError.tooManyTerms }
        return terms.map { term in
            if term.count == 1 { return "\"\(token(prefix: 117, scalars: term.map(\.value)))\"" }
            if term.count == 2 { return "\"\(token(prefix: 98, scalars: term.map(\.value)))\"" }
            let trigrams = (0 ... term.count - 3).map { index in
                token(prefix: 116, scalars: [term[index].value, term[index + 1].value, term[index + 2].value])
            }
            return "\"" + trigrams.joined(separator: " ") + "\""
        }.joined(separator: " AND ")
    }

    private static func token(prefix: UInt8, scalars: [UInt32]) -> String {
        var bytes = [prefix]
        bytes.reserveCapacity(1 + scalars.count * 6)
        for scalar in scalars { appendHex(scalar, to: &bytes) }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func appendHex(_ value: UInt32, to bytes: inout [UInt8]) {
        for shift in stride(from: 20, through: 0, by: -4) {
            let digit = UInt8((value >> UInt32(shift)) & 0x0f)
            bytes.append(digit < 10 ? 48 + digit : 87 + digit)
        }
    }
}

private final class FeedSearchCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.withLock { cancelled = true } }
    var isCancelled: Bool { lock.withLock { cancelled } }
}

private final class FeedSearchHandle: @unchecked Sendable {
    let db: OpaquePointer
    init(_ db: OpaquePointer) { self.db = db }
    deinit { sqlite3_close_v2(db) }
}

actor FeedLibrarySearchReader {
    private let connection: FeedSearchHandle
    private var indexReady = false

    init(url: URL) throws {
        var opened: OpaquePointer?
        guard sqlite3_open_v2(url.path, &opened, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let opened else {
            if let opened { sqlite3_close_v2(opened) }
            throw FeedError.unavailable
        }
        guard sqlite3_exec(
            opened,
            "PRAGMA query_only=ON;PRAGMA busy_timeout=100;PRAGMA mmap_size=2147418112;PRAGMA cache_size=-65536",
            nil, nil, nil
        ) == SQLITE_OK else {
            sqlite3_close_v2(opened)
            throw FeedError.unavailable
        }
        connection = FeedSearchHandle(opened)
    }

    func search(_ request: ArticleSearchRequest) async throws -> ArticleSearchPage {
        let boundedLimit = max(0, min(request.limit, 200))
        guard boundedLimit > 0 else { return ArticleSearchPage(results: [], nextCursor: nil) }
        guard let expression = try FeedSearchText.matchExpression(request.text) else {
            return ArticleSearchPage(results: [], nextCursor: nil)
        }
        let cancellation = FeedSearchCancellation()
        let connection = connection
        return try await withTaskCancellationHandler {
            if Task.isCancelled { throw ArticleSearchError.interrupted }
            sqlite3_progress_handler(connection.db, 1_000, { context in
                guard let context else { return 0 }
                let state = Unmanaged<FeedSearchCancellation>.fromOpaque(context).takeUnretainedValue()
                return state.isCancelled ? 1 : 0
            }, Unmanaged.passUnretained(cancellation).toOpaque())
            defer { sqlite3_progress_handler(connection.db, 0, nil, nil) }
            do { return try self.execute(request, expression: expression, limit: boundedLimit) }
            catch {
                if cancellation.isCancelled || Task.isCancelled { throw ArticleSearchError.interrupted }
                throw error
            }
        } onCancel: {
            cancellation.cancel()
            sqlite3_interrupt(connection.db)
        }
    }

    private func execute(_ request: ArticleSearchRequest, expression: String, limit: Int) throws -> ArticleSearchPage {
        // Readiness is monotonic for this schema. Once ready, normal queries
        // retain their single joined snapshot without a per-call metadata read.
        if !indexReady {
            guard try FeedArticleSearchIndex.preparationStatus(on: connection.db).isReady else {
                throw ArticleSearchError.notReady
            }
            indexReady = true
        }
        var predicates = [
            "article_search_fts MATCH ?",
            "d.indexed_source_fingerprint=d.source_fingerprint",
        ]
        if request.feedID != nil { predicates.append("d.feed_id=?") }
        if request.bookmarksOnly { predicates.append("EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id=d.article_id)") }
        if request.before != nil { predicates.append("article_search_fts.rowid<?") }
        let sql = """
            WITH selected AS (
              SELECT d.article_id,d.source_fingerprint,article_search_fts.rowid AS order_id,
                     EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id=d.article_id) AS is_bookmarked
              FROM article_search_fts
              JOIN article_search_documents d ON d.order_id=article_search_fts.rowid
              WHERE \(predicates.joined(separator: " AND "))
              ORDER BY article_search_fts.rowid DESC
              LIMIT ?
            )
            SELECT a.id,a.feed_id,a.remote_id,a.title,a.url,a.summary,a.content,a.published,
                   t.source_fingerprint,t.title,t.body,selected.order_id,selected.is_bookmarked
            FROM selected
            JOIN articles a ON a.id=selected.article_id
            LEFT JOIN translations t ON t.article_id=a.id AND t.target_language='ja'
              AND t.source_fingerprint=selected.source_fingerprint
            ORDER BY selected.order_id DESC
            """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection.db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw ArticleSearchError.unavailable
        }
        defer { sqlite3_finalize(statement) }
        var parameter: Int32 = 1
        try bind(expression, parameter, statement); parameter += 1
        if let feedID = request.feedID { try bind(feedID, parameter, statement); parameter += 1 }
        if let before = request.before {
            guard sqlite3_bind_int64(statement, parameter, before) == SQLITE_OK else { throw ArticleSearchError.unavailable }
            parameter += 1
        }
        guard sqlite3_bind_int64(statement, parameter, Int64(limit + 1)) == SQLITE_OK else { throw ArticleSearchError.unavailable }
        var results: [ArticleSearchResult] = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW:
                let article = try article(statement)
                let translation: ArticleTranslation?
                if sqlite3_column_type(statement, 8) == SQLITE_NULL {
                    translation = nil
                } else {
                    translation = ArticleTranslation(
                        articleID: article.id, sourceFingerprint: try text(statement, 8), targetLanguage: "ja",
                        title: try text(statement, 9), body: try text(statement, 10)
                    )
                }
                guard sqlite3_column_type(statement, 12) == SQLITE_INTEGER else {
                    throw ArticleSearchError.unavailable
                }
                results.append(ArticleSearchResult(
                    article: article, translation: translation,
                    cursor: sqlite3_column_int64(statement, 11),
                    isBookmarked: sqlite3_column_int(statement, 12) != 0
                ))
            case SQLITE_DONE:
                let hasMore = results.count > limit
                if hasMore { results.removeLast() }
                return ArticleSearchPage(results: results, nextCursor: hasMore ? results.last?.cursor : nil)
            case SQLITE_INTERRUPT: throw ArticleSearchError.interrupted
            default: throw ArticleSearchError.unavailable
            }
        }
    }

    private func article(_ statement: OpaquePointer) throws -> FeedArticle {
        let rawURL = try optionalText(statement, 4)
        let url: URL?
        if let rawURL, let parsed = URL(string: rawURL) { url = parsed }
        else if rawURL == nil { url = nil }
        else { throw ArticleSearchError.unavailable }
        let published: Date?
        if sqlite3_column_type(statement, 7) == SQLITE_NULL { published = nil }
        else {
            let seconds = sqlite3_column_double(statement, 7)
            guard seconds.isFinite else { throw ArticleSearchError.unavailable }
            published = Date(timeIntervalSinceReferenceDate: seconds)
        }
        return FeedArticle(
            id: try text(statement, 0), feedID: try text(statement, 1), remoteID: try optionalText(statement, 2),
            title: try text(statement, 3), url: url, summary: try text(statement, 5),
            content: try text(statement, 6), publishedAt: published
        )
    }

    private func text(_ statement: OpaquePointer, _ column: Int32) throws -> String {
        guard sqlite3_column_type(statement, column) == SQLITE_TEXT,
              let bytes = sqlite3_column_text(statement, column) else { throw ArticleSearchError.unavailable }
        return String(cString: bytes)
    }
    private func optionalText(_ statement: OpaquePointer, _ column: Int32) throws -> String? {
        sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : try text(statement, column)
    }
    private func bind(_ value: String, _ index: Int32, _ statement: OpaquePointer) throws {
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard value.withCString({ sqlite3_bind_text(statement, index, $0, -1, transient) }) == SQLITE_OK else {
            throw ArticleSearchError.unavailable
        }
    }
}
