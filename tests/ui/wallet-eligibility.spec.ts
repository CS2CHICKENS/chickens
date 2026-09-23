import { test, expect } from "@playwright/test";
import { emptyState } from "../../packages/core/src/state";

test("excluded wallets retain balances without showing reward weights", async ({
  page,
}) => {
  const state = structuredClone(emptyState);
  state.mode = "monitoring";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.stale = false;
  const wallet = "0x" + "2".repeat(40);
  const ledger = {
    address: wallet,
    updatedAt: state.updatedAt,
    eligibility: false as boolean | null,
    chickStreak: 2,
    holdings: [],
    chickWeightWei: "2000000000000000000",
    roundWeight: { catalana: "500000000000000000" },
    carryover: [],
    received: [],
  };
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.route("https://data.cs2chickens.fun/wallets/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(ledger),
    }),
  );
  await page.route(
    /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
    async (route) => {
      const request = route.request().postDataJSON();
      const rows = Array.isArray(request) ? request : [request];
      const responses = rows.map((row: { id: number }) => ({
        id: row.id,
        jsonrpc: "2.0",
        result: "0x" + (10n ** 18n).toString(16).padStart(64, "0"),
      }));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(request) ? responses : responses[0]),
      });
    },
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/check/");
  await page.getByRole("textbox").fill(wallet);
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await expect(page.locator(".wallet-ledger")).toContainText(
    "Excluded from holder rewards",
  );
  await expect(page.locator(".wallet-ledger")).toContainText("NOT ELIGIBLE");
  await expect(page.locator(".wallet-ledger")).not.toContainText("0.5 ETH");
  await expect(page.locator("table").first()).toContainText("CATALANA");
  ledger.eligibility = null;
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await expect(page.locator(".wallet-ledger")).toContainText(
    "eligibility has not been verified",
  );
  await expect(page.locator(".wallet-ledger")).toContainText("NOT VERIFIED");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
