export type ReaderSelection = {
  context: string;
  text: string;
  start: number;
  end: number;
};

export function captureReaderSelection(
  source: HTMLElement | null,
): ReaderSelection | null {
  const selection = window.getSelection();
  if (
    !source?.dataset.selectionContext ||
    !selection?.rangeCount ||
    selection.isCollapsed
  )
    return null;
  const range = selection.getRangeAt(0);
  if (
    !source.contains(range.startContainer) ||
    !source.contains(range.endContainer)
  )
    return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(source);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return {
    context: source.dataset.selectionContext,
    text: source.textContent ?? "",
    start,
    end: prefix.toString().length,
  };
}

export function restoreReaderSelection(
  saved: ReaderSelection | null,
  source: HTMLElement | null,
) {
  // 別の記事・原文/訳文・本文の変更後には、古い位置を新しい本文へ移さない。
  if (
    !saved ||
    !source ||
    source.dataset.selectionContext !== saved.context ||
    source.textContent !== saved.text
  )
    return;
  const nodes = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && saved.start >= offset && saved.start < offset + length) {
      range.setStart(node, saved.start - offset);
      started = true;
    }
    if (started && saved.end <= offset + length) {
      range.setEnd(node, saved.end - offset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    offset += length;
  }
}
