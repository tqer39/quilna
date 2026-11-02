import "./style.css";
import { initializeLibraryContext } from "./library-context";
let initialized = false;
try {
  await initializeLibraryContext();
  initialized = true;
} catch {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const message = document.createElement("p");
  message.textContent =
    "ライブラリを開けませんでした。記録は保持しています。ログイン状態と接続を確認して再読み込みしてください。";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "再読み込み";
  retry.addEventListener("click", () => location.reload());
  root.replaceChildren(message, retry);
}
if (initialized) await start();
async function start() {
  if (new URLSearchParams(location.search).get("view") === "papers") {
    const { paperView } = await import("./paper-view");
    await paperView(document.querySelector<HTMLDivElement>("#app")!);
  } else if (new URLSearchParams(location.search).get("view") === "textbooks") {
    const { sharedTextbookView } = await import("./shared-textbook-view");
    await sharedTextbookView(document.querySelector<HTMLDivElement>("#app")!);
  } else if (
    new URLSearchParams(location.search).get("view") === "lesson" ||
    (location.hash &&
      new URLSearchParams(location.search).get("view") !== "feeds")
  ) {
    await import("./main");
  } else {
    const { feedReader } = await import("./feed-reader");
    await feedReader(document.querySelector<HTMLDivElement>("#app")!);
  }
}
