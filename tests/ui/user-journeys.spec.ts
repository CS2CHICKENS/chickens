import { test, expect } from "@playwright/test";
import { emptyState } from "../../packages/core/src/state";

test("new visitors can distinguish score from rewards and reach the exact payout rules", async ({
  page,
}) => {
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  const race = await page.locator(".race").boundingBox();
  expect(race!.y + race!.height).toBeLessThanOrEqual(640);
  const guide = page.getByRole("region", {
    name: "TRADING SETS THE SCORE. HOLDING SETS YOUR SHARE.",
  });
  await expect(guide).toContainText("no claim transaction");
  await expect(guide).toContainText(
    "Timeout and fire rounds pay no holder rewards",
  );
  await guide.getByRole("link", { name: "HOW REWARDS WORK" }).click();
  await expect(
    page.locator('[id="7-who-gets-paid-and-how-much"]'),
  ).toBeInViewport();
  await page.goto("/inventory/catalana/");
  await page.getByRole("button", { name: "MENU" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Play", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "MENU" })).toBeFocused();
  await expect(page.getByRole("button", { name: "MENU" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: "MENU" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Inventory", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("data status separates unavailable, reconciling and current records with manual recovery", async ({
  page,
}) => {
  let available = false;
  const state = structuredClone(emptyState);
  Object.assign(state, {
    updatedAt: Math.floor(Date.now() / 1000),
    headBlock: 100,
    mode: "live",
    stale: false,
  });
  state.feed.accountingReady = false;
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    available ? route.fulfill({ json: state }) : route.fulfill({ status: 503 }),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/status/");
  const summary = page.getByRole("region", { name: "Public data status" });
  await expect(summary).toContainText("DATA UNAVAILABLE");
  await expect(summary).not.toContainText("DATA UP TO DATE");
  available = true;
  await page.getByRole("button", { name: "REFRESH NOW" }).click();
  await expect(summary).toContainText("DATA UP TO DATE");
  await expect(
    page.getByRole("heading", { name: "CALCULATIONS CATCHING UP" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "CONTRACT SETUP PENDING" }),
  ).toBeVisible();
  state.feed.accountingReady = true;
  state.feed.collection = {
    status: "verified",
    fromBlock: 1,
    throughBlock: 100,
    lowerBoundWei: "0",
    upperBoundWei: "0",
    escrowClaimedWei: "0",
    otherCreditsWei: "0",
  };
  await page.getByRole("button", { name: "REFRESH NOW" }).click();
  await expect(
    page.getByRole("heading", { name: "PUBLISHED TOTALS RECONCILED" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "COLLECTION RECONCILED", exact: true }),
  ).toBeVisible();
  available = false;
  await page.getByRole("button", { name: "REFRESH NOW" }).click();
  await expect(page.getByRole("button", { name: "REFRESH NOW" })).toBeEnabled();
  await expect(summary).toContainText("LAST VERIFIED RECORD");
  await expect(
    summary.getByRole("link", { name: "INDEXED BLOCK" }),
  ).toHaveAttribute("href", "https://robinhoodchain.blockscout.com/block/100");
  await expect(page.locator(".status-strip")).toContainText("DATA DELAYED");
  await expect(page.locator(".status-strip .live")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "private/verification/data-status-mobile.png",
    fullPage: true,
  });
});
