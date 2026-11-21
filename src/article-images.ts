export type ArticleImage = {
  offset: number;
  alt: string;
  data: string;
  width: number;
  height: number;
};
export type ImageSource = Pick<ArticleImage, "alt" | "offset"> & {
  url: string;
};
export const articleImageLimit = 12;
const maxDataLength = 360_000;
const maxDimension = 1440;

export function validArticleImages(value: unknown, length: number) {
  return (
    Array.isArray(value) &&
    value.length <= articleImageLimit &&
    value.every(
      (item, index) =>
        item &&
        Number.isInteger(item.offset) &&
        item.offset >= 0 &&
        item.offset <= length &&
        (!index || item.offset >= value[index - 1].offset) &&
        typeof item.alt === "string" &&
        item.alt.length <= 500 &&
        [item.width, item.height].every(
          (n) => Number.isInteger(n) && n > 0 && n <= maxDimension,
        ) &&
        typeof item.data === "string" &&
        item.data.length <= maxDataLength &&
        /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/u.test(
          item.data,
        ),
    )
  );
}

export async function importArticleImages(sources: ImageSource[]) {
  const images: ArticleImage[] = [];
  const signal = AbortSignal.timeout(20000);
  for (const source of sources.slice(0, articleImageLimit)) {
    if (signal.aborted) break;
    try {
      const response = await fetch("/api/feeds/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: source.url, image: true }),
        signal,
      });
      if (!response.ok) continue;
      const { image } = await response.json();
      if (
        typeof image !== "string" ||
        !/^data:image\/(png|jpeg|gif|webp|avif);base64,/.test(image)
      )
        continue;
      const img = new Image();
      img.src = image;
      await img.decode();
      if (Math.min(img.naturalWidth, img.naturalHeight) <= 1) continue;
      const canvas = document.createElement("canvas");
      for (const limit of [maxDimension, 960, 640]) {
        const scale = Math.min(
          1,
          limit / Math.max(img.naturalWidth, img.naturalHeight),
        );
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        let data = canvas.toDataURL("image/webp", 0.78);
        if (!data.startsWith("data:image/webp;base64,")) {
          // WebP を書き出せない環境では、透明な図版を白地に合成する。
          context.globalCompositeOperation = "destination-over";
          context.fillStyle = "white";
          context.fillRect(0, 0, canvas.width, canvas.height);
          data = canvas.toDataURL("image/jpeg", 0.78);
          if (!data.startsWith("data:image/jpeg;base64,")) continue;
        }
        if (data.length > maxDataLength) continue;
        images.push({
          offset: source.offset,
          alt: source.alt,
          data,
          width: canvas.width,
          height: canvas.height,
        });
        break;
      }
    } catch {
      // 個別の画像が取得できなくても、本文と取得できた図版を保存する。
    }
  }
  return images;
}
