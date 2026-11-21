type Entry = {
  word: string;
  aliases: string[];
  meaning: string;
  synonyms: string[];
  contrasts: string[];
  related: string[];
  source: { name: string; url: string };
};

// 定義は短い編集済みの説明。検索しただけで生成や外部への送信を始めない。
export const quickDictionary: readonly Entry[] = [
  {
    word: "RSS",
    aliases: ["Really Simple Syndication"],
    meaning:
      "サイトの更新を、記事の題名・リンク・概要などを含む一定の形式で受け取る仕組みです。Atomは別の配信形式です。",
    synonyms: ["フィード配信"],
    contrasts: [],
    related: ["Atom", "非同期", "キャッシュ"],
    source: {
      name: "RSS 2.0 Specification",
      url: "https://www.rssboard.org/rss-specification",
    },
  },
  {
    word: "Atom",
    aliases: ["Atomフィード"],
    meaning:
      "記事などの更新情報を配信するためのXML形式です。RSSとは別の仕様で、題名・識別子・更新日時などを扱います。",
    synonyms: [],
    contrasts: [],
    related: ["RSS"],
    source: {
      name: "RFC 4287: The Atom Syndication Format",
      url: "https://www.rfc-editor.org/rfc/rfc4287.html",
    },
  },
  {
    word: "キャッシュ",
    aliases: ["cache", "caching"],
    meaning:
      "一度取得した情報のコピーを保存し、次の要求で再利用する仕組みです。古くなった情報の更新確認も必要です。",
    synonyms: ["一時保存"],
    contrasts: [],
    related: ["RSS", "非同期"],
    source: {
      name: "MDN: HTTP caching",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching",
    },
  },
  {
    word: "非同期",
    aliases: ["asynchronous", "async", "非同期処理"],
    meaning:
      "時間のかかる処理の完了を待つ間に、別の処理を進められる方式です。複数の処理を同時に実行することと必ずしも同じではありません。",
    synonyms: ["非同期処理"],
    contrasts: ["同期"],
    related: ["キャッシュ", "RSS"],
    source: {
      name: "MDN: Asynchronous",
      url: "https://developer.mozilla.org/en-US/docs/Glossary/Asynchronous",
    },
  },
  {
    word: "同期",
    aliases: ["synchronous", "同期処理"],
    meaning:
      "一つの処理が終わってから次の処理へ進む方式です。データのコピー同士を揃える「同期」とは文脈を分けて使います。",
    synonyms: ["同期処理"],
    contrasts: ["非同期"],
    related: ["キャッシュ"],
    source: {
      name: "MDN: Synchronous",
      url: "https://developer.mozilla.org/en-US/docs/Glossary/Synchronous",
    },
  },
  {
    word: "大規模言語モデル",
    aliases: ["LLM", "LLMs", "large language model", "large language models"],
    meaning:
      "大量の文章などから言葉の並び方を学んだ、大規模なモデルです。文章の続きを予測する仕組みを使って、質問への回答や要約も作れます。",
    synonyms: ["LLM"],
    contrasts: [],
    related: ["トークン", "プロンプト", "RAG"],
    source: {
      name: "Google 機械学習用語集",
      url: "https://developers.google.com/machine-learning/glossary?hl=ja#large-language-model",
    },
  },
  {
    word: "RAG",
    aliases: [
      "検索拡張生成",
      "retrieval-augmented generation",
      "retrieval augmented generation",
    ],
    meaning:
      "質問に関係する資料を検索し、その内容をモデルに渡して回答を作る方法です。たとえば、更新された製品マニュアルを回答の根拠にできます。",
    synonyms: ["検索拡張生成"],
    contrasts: [],
    related: ["大規模言語モデル", "プロンプト"],
    source: {
      name: "Google 機械学習用語集",
      url: "https://developers.google.com/machine-learning/glossary?hl=ja#retrieval-augmented-generation-rag",
    },
  },
  {
    word: "トークン",
    aliases: ["token", "tokens"],
    meaning:
      "言語モデルが文章を読み書きするときの単位です。一つの単語が複数のトークンに分かれることもあり、文章の文字数とは数え方が異なります。",
    synonyms: [],
    contrasts: [],
    related: ["大規模言語モデル", "プロンプト"],
    source: {
      name: "Google 機械学習用語集",
      url: "https://developers.google.com/machine-learning/glossary?hl=ja#token",
    },
  },
  {
    word: "プロンプト",
    aliases: ["prompt", "prompts"],
    meaning:
      "生成モデルに渡す入力です。「この記事を三行で要約して」という指示に加え、要約する記事や回答例も含められます。",
    synonyms: [],
    contrasts: [],
    related: ["大規模言語モデル", "RAG", "トークン"],
    source: {
      name: "Google 機械学習用語集",
      url: "https://developers.google.com/machine-learning/glossary?hl=ja#prompt",
    },
  },
  {
    word: "推論",
    aliases: ["inference", "モデル推論"],
    meaning:
      "機械学習で、学習済みモデルを使って新しい入力に対する予測や出力を得ることです。記事を入力して要約を得るのも一例です。",
    synonyms: [],
    contrasts: ["モデルの学習"],
    related: ["大規模言語モデル"],
    source: {
      name: "Google 機械学習用語集",
      url: "https://developers.google.com/machine-learning/glossary?hl=ja#inference",
    },
  },
  {
    word: "モデルの学習",
    aliases: ["training", "モデル訓練"],
    meaning:
      "データを使ってモデルのパラメーターを調整する過程です。たとえば、予測した次の単語と実際の単語のずれを使って調整します。",
    synonyms: ["モデル訓練"],
    contrasts: ["推論"],
    related: ["大規模言語モデル", "トークン"],
    source: {
      name: "Google 機械学習用語集",
      url: "https://developers.google.com/machine-learning/glossary?hl=ja#training",
    },
  },
];

const normalize = (word: string) =>
  word.normalize("NFKC").trim().toLocaleLowerCase();
export function findQuickDefinition(word: string) {
  const value = normalize(word);
  return quickDictionary.find((entry) =>
    [entry.word, ...entry.aliases].some((alias) => normalize(alias) === value),
  );
}

// 長い表記を先に照合し、「非同期処理」を「同期」へ分割しない。
const spellings = quickDictionary
  .flatMap((entry) => [entry.word, ...entry.aliases])
  .sort((a, b) => b.length - a.length)
  .map((word) => {
    const literal = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = /^[a-z0-9]/i.test(word) ? "(?<![a-z0-9])" : "";
    const after = /[a-z0-9]$/i.test(word) ? "(?![a-z0-9])" : "";
    return before + literal + after;
  });
const headlinePattern = new RegExp(spellings.join("|"), "giu");

export function dictionaryPhrases(title: string) {
  return Array.from(title.matchAll(headlinePattern), (match) => match[0]);
}
