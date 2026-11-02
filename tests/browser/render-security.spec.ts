import { test, expect } from "@playwright/test";

test("restricted Markdown keeps HTML and executable links as inert text", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/src/ui.ts";
    const { markdown } = await import(modulePath);
    const payload =
      '<img src=x onerror="window.xssExecuted=true"><script>window.xssExecuted=true</script> [click](javascript:alert(1)) **safe**';
    const target = document.createElement("aside");
    target.id = "security-markdown";
    target.append(markdown(payload));
    document.body.append(target);
  });
  const target = page.locator("#security-markdown");
  await expect(target).toContainText("<img src=x");
  await expect(target.locator("img,script,a,iframe")).toHaveCount(0);
  await expect(target.locator("strong")).toHaveText("safe");
  expect(await page.evaluate(() => "xssExecuted" in window)).toBe(false);
});
