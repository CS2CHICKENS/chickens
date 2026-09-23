import { test, expect } from "@playwright/test";
const routes = [
  "/",
  "/inventory/",
  "/inventory/catalana/",
  "/inventory/polish/",
  "/inventory/silkie/",
  "/incubator/",
  "/rounds/",
  "/kitchen/",
  "/feed/",
  "/check/",
  "/whitepaper/",
  "/status/",
  "/verify/",
];
for (const width of [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920, 2560])
  for (const orientation of ["portrait", "landscape"]) {
    const height =
      orientation === "portrait"
        ? Math.max(640, Math.round(width * 1.3))
        : Math.max(320, Math.round(width * 0.5625));
    test(width + " " + orientation, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.route("https://data.cs2chickens.fun/**", (route) =>
        route.fulfill({ status: 404, body: "{}" }),
      );
      await page.route(
        /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
        (route) => route.abort(),
      );
      for (const path of routes) {
        await page.goto(path, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator("h1")).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          path + " overflow",
        ).toBe(true);
        const broken = await page
          .locator("img")
          .evaluateAll((images) =>
            images
              .filter((image) => image.complete && image.naturalWidth === 0)
              .map((image) => image.getAttribute("src")),
          );
        expect(broken, path + " broken images").toEqual([]);
        await page.screenshot({
          path: info.outputPath(
            path.replaceAll("/", "_") + width + "-" + orientation + ".png",
          ),
          fullPage: true,
        });
      }
    });
  }
test("mobile controls and above-fold family race", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  const race = await page.locator(".race").boundingBox();
  expect(race!.y + race!.height).toBeLessThanOrEqual(640);
  await page.getByRole("button", { name: "MENU" }).click();
  await page.getByRole("link", { name: "Check wallet", exact: true }).click();
  await page.getByRole("textbox").fill("not-an-address");
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await expect(page.locator(".wallet-form [role=alert]")).toContainText(
    "valid",
  );
});
