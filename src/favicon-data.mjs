// Only small raster/icon payloads can reach an <img>; never SVG or HTML.
export function faviconData(bytes) {
  return rasterData(bytes, false);
}

export function articleImageData(bytes) {
  return rasterData(bytes, true);
}

export const articleImageAccept =
  "image/avif,image/webp,image/png,image/jpeg,image/gif";

function hasAvifBrand(bytes) {
  if (
    bytes.length < 16 ||
    String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp"
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(0);
  let major = 8;
  if (size === 1) {
    if (bytes.length < 24 || view.getUint32(8) !== 0) return false;
    size = view.getUint32(12);
    major = 16;
  }
  if (size < major + 8 || size > bytes.length || size % 4 !== 0) return false;
  // minor_version と後続ボックス内の文字列は形式判定に含めない。
  for (let i = major; i < size; i += i === major ? 8 : 4) {
    const brand = view.getUint32(i);
    if (brand === 0x61766966 || brand === 0x61766973) return true; // avif / avis
  }
  return false;
}

function rasterData(bytes, article) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > (article ? 4_000_000 : 65536)
  )
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
            : article && hasAvifBrand(bytes)
              ? "image/avif"
              : null;
  if (!type || (article && type === "image/x-icon")) throw Error("icon-type");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096)
    binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return `data:${type};base64,${globalThis.btoa(binary)}`;
}
