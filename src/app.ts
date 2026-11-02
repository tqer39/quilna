import "./style.css";
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
