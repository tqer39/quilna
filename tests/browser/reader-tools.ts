import type { Page } from "@playwright/test";

/** Open the user-facing tools disclosure before operating an optional reader tool. */
export async function openReaderTools(page: Page) {
  const tools = page.locator("#rss-reading-extras");
  if (!(await tools.count())) return; // Standalone component fixtures have no reader shell.
  if ((await tools.getAttribute("open")) === null)
    await tools.locator(":scope > summary").click();
}
