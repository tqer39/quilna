// eslint-disable-next-line no-control-regex -- Remove control characters from untrusted publisher labels.
const controls = /[\u0000-\u001f\u007f]/g;
// Publisher declarations remain plain text, separate from personal labels.
export function normalizeSourceTags(values: string[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = value
      .normalize("NFKC")
      .replace(controls, " ")
      .trim();
    const key = tag.toLowerCase();
    if (!tag || tag.length > 60 || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 20) break;
  }
  return tags;
}
export function validSourceTags(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (tag) =>
        typeof tag === "string" &&
        tag.length > 0 &&
        tag.length <= 60 &&
        tag.replace(controls, "") === tag,
    )
  );
}
