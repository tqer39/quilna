import { el } from "./ui";

export const readerDesignKey = "quilna.reader.design.v1";
export const readerDesigns = [
  {
    id: "studio",
    name: "Studio",
    description: "新着を軽快に探す、明るいカード表示。",
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "紙面のような文字組みで、じっくり読む。",
  },
  {
    id: "focus",
    name: "Focus",
    description: "落ち着いたダークカラーで、本文に集中。",
  },
] as const;
type ReaderDesign = (typeof readerDesigns)[number]["id"];

function validDesign(value: string | null): ReaderDesign {
  return readerDesigns.find((design) => design.id === value)?.id ?? "studio";
}

export function readerDesignSettings() {
  let selected: ReaderDesign = "studio";
  let readFailed = false;
  try {
    selected = validDesign(localStorage.getItem(readerDesignKey));
  } catch {
    readFailed = true;
  }
  document.documentElement.dataset.readerDesign = selected;
  const section = el("fieldset", undefined, "rss-design-settings");
  section.append(el("legend", "ビューアのデザイン"));
  section.append(
    el(
      "p",
      "読み方に合わせて選べます。記事や保存状態はそのまま、すぐに切り替わります。",
      "muted",
    ),
  );
  const choices = el("div", undefined, "rss-design-choices");
  const notice = el(
    "p",
    readFailed
      ? "デザイン設定を読み込めませんでした。Studioで表示しています。"
      : "このブラウザに保存します。いつでも変更できます。",
    "muted",
  );
  notice.setAttribute("role", "status");
  for (const design of readerDesigns) {
    const label = el("label", undefined, "rss-design-choice");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "reader-design";
    radio.value = design.id;
    radio.checked = selected === design.id;
    const preview = el("span", undefined, "rss-design-preview");
    preview.dataset.preview = design.id;
    preview.setAttribute("aria-hidden", "true");
    preview.append(el("i"), el("i"), el("i"));
    const name = el("strong", design.name);
    const description = el(
      "span",
      design.description,
      "rss-design-description",
    );
    description.id = `reader-design-${design.id}-description`;
    radio.setAttribute("aria-label", design.name);
    radio.setAttribute("aria-describedby", description.id);
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      document.documentElement.dataset.readerDesign = design.id;
      try {
        localStorage.setItem(readerDesignKey, design.id);
        notice.textContent = `${design.name}を保存しました。`;
      } catch {
        notice.textContent =
          "デザインを保存できませんでした。今回は適用しますが、次回は設定し直してください。";
      }
    });
    label.append(radio, name, preview, description);
    choices.append(label);
  }
  section.append(choices, notice);
  return section;
}
