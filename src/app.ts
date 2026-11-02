import "./style.css";
if (
  new URLSearchParams(location.search).get("view") === "lesson" ||
  (location.hash &&
    new URLSearchParams(location.search).get("view") !== "feeds")
) {
  await import("./main");
} else {
  const { feedReader } = await import("./feed-reader");
  await feedReader(document.querySelector<HTMLDivElement>("#app")!);
}
