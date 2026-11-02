import { test, expect } from "@playwright/test";

test("contents reaches the final section in a short window without losing the reading position", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  await page.setViewportSize(
    mobile ? { width: 390, height: 640 } : { width: 1280, height: 640 },
  );
  await page.goto("/#read");
  const sidebar = page.locator("aside");
  const contents = page.getByRole("navigation", {
    name: "目次",
    includeHidden: true,
  });
  const last = contents.getByRole("link", {
    name: "13 / 明日、説明できるように",
    exact: true,
    includeHidden: true,
  });

  if (mobile) {
    await sidebar.getByText("このセクションの目次", { exact: true }).click();
    await last.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(0);
  } else {
    await page.locator("article").hover();
    const beforeScroll = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => page.evaluate(() => scrollY))
      .toBe(beforeScroll + 600);
    await expect
      .poll(() =>
        sidebar.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBe(30);
    const readingPosition = await page.evaluate(() => scrollY);
    await sidebar.getByText("このセクションの目次", { exact: true }).hover();
    await page.mouse.wheel(0, 1600);
    await expect(last).toBeInViewport({ ratio: 1 });
    expect(
      await sidebar.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
    // A second wheel at the end must not chain into the article's scroll position.
    await last.hover();
    await page.mouse.wheel(0, 600);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await page.evaluate(() => scrollY)).toBe(readingPosition);
  }

  await expect(last).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("contents-end.png") });
  await last.click();
  await expect(page).toHaveURL(/#takeaway$/);
  const heading = page.getByRole("heading", {
    name: "13 / 明日、説明できるように",
    exact: true,
  });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(last).toHaveAttribute("aria-current", "step");
  if (mobile)
    await expect(sidebar.locator("details")).not.toHaveAttribute("open");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
