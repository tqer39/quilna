// Only small raster/icon payloads can reach an <img>; never SVG or HTML.
export function faviconData(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65536)
    throw Error("icon-size");
  const starts = (...signature) => signature.every((n, i) => bytes[i] === n);
  const ascii = (start, end) =>
    String.fromCharCode(...bytes.subarray(start, end));
  const type = starts(137, 80, 78, 71, 13, 10, 26, 10)
    ? "image/png"
    : starts(255, 216, 255)
      ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(ascii(0, 6))
        ? "image/gif"
        : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
          ? "image/webp"
          : starts(0, 0, 1, 0) && bytes.length >= 6
            ? "image/x-icon"
            : null;
  if (!type) throw Error("icon-type");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096)
    binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return `data:${type};base64,${globalThis.btoa(binary)}`;
}
