import { test, expect } from "@playwright/test";
import { emptyState } from "../../packages/core/src/state";

test("unverified current and historical fee amounts are never shown as settled pots", async ({
  page,
}) => {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.stale = false;
  state.round.potWei = "8500000000000000";
  state.feed.accruingWei = state.round.potWei;
  state.history.rounds = [
    {
      id: 1,
      winner: "catalana",
      potWei: state.round.potWei,
      endReason: "threshold",
      endBlock: 100,
      accountingVerified: false,
      settlementStatus: "pending",
      payoutTransactions: [],
    },
  ];
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/");
  await expect(page.locator(".status-strip")).toContainText("SEASON 01 · LIVE");
  await expect(page.locator(".feed-meter strong")).toContainText("—");
  await page.goto("/feed/");
  const pot = page
    .locator(".feed-stats > div")
    .filter({ hasText: "CURRENT ROUND POT" });
  await expect(pot).toContainText("—");
  await expect(page.locator("table")).toContainText("NOT VERIFIED");
  state.feed.generatedRoundWei = "17000000000000000";
  state.history.rounds[0].accountingVerified = true;
  await expect(pot).toContainText("0.0085 ETH", { timeout: 10000 });
  await expect(page.locator("table")).not.toContainText("NOT VERIFIED");
});
