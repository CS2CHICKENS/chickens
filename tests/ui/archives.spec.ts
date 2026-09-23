import { test, expect } from "@playwright/test";
import { emptyState } from "../../packages/core/src/state";

test("round archives recover from errors and preserve all-time wins on mobile", async ({
  page,
}) => {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.stale = false;
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.history.wins = { catalana: 211, polish: 3, silkie: 8 };
  state.history.pages = {
    pageSize: 100,
    totalPages: 3,
    basePath: "history/rounds/",
  };
  const row = {
    id: 211,
    winner: "catalana",
    potWei: "1000000000000000000",
    endReason: "threshold",
    endBlock: 100,
    accountingVerified: true,
    settlementStatus: "published" as const,
    payoutTransactions: [],
  };
  state.history.rounds = [row];
  let available = false;
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ json: state }),
  );
  await page.route(
    "https://data.cs2chickens.fun/history/rounds/0.json",
    (route) =>
      available
        ? route.fulfill({
            json: { page: 0, pageSize: 100, rounds: [{ ...row, id: 1 }] },
          })
        : route.fulfill({ status: 503 }),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/rounds/");
  await expect(page.locator(".hall")).toContainText("211");
  await page.getByLabel("Round archive").selectOption("0");
  await expect(page.locator(".archive-picker [role=alert]")).toContainText(
    "archive is unavailable",
  );
  available = true;
  await page.getByRole("button", { name: "RETRY", exact: true }).click();
  await expect(
    page.locator("tbody tr").first().locator("td").first(),
  ).toHaveText("1");
  await expect(page.locator(".hall")).toContainText("211");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "private/verification/round-archive-mobile.png",
    fullPage: true,
  });
  await page.goto("/feed/");
  await page.getByLabel("Payout archive").selectOption("0");
  await expect(
    page.locator("tbody tr").first().locator("td").first(),
  ).toHaveText("1");
});

test("mixed fee claims disclose verified bounds and hide unsettled aggregate counters", async ({
  page,
}) => {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.stale = true;
  state.updatedAt = Math.floor(Date.now() / 1000);
  Object.assign(state.feed, {
    accountingReady: false,
    owedWei: "99000000000000000000",
    collection: {
      status: "ambiguous",
      fromBlock: 10,
      throughBlock: 100,
      lowerBoundWei: "1000000000000000000",
      upperBoundWei: "2000000000000000000",
      escrowClaimedWei: "3000000000000000000",
      otherCreditsWei: "2000000000000000000",
    },
  });
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ json: state }),
  );
  await page.goto("/feed/");
  await expect(page.locator(".fee-accounting")).toContainText(
    "between 1 and 2 ETH",
  );
  await expect(page.locator(".feed-stats")).not.toContainText("99");
  await expect(page.locator(".feed-stats")).toContainText("—");
});

test("wallet payment archives show older receipts and distinguish an empty range", async ({
  page,
}) => {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.stale = false;
  state.updatedAt = Math.floor(Date.now() / 1000);
  const address = "0x" + "2".repeat(40),
    tx = "0x" + "a".repeat(64);
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ json: state }),
  );
  await page.route(
    /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
    async (route) => {
      const body = route.request().postDataJSON(),
        rows = Array.isArray(body) ? body : [body];
      const result = rows.map((row: { id: number }) => ({
        id: row.id,
        jsonrpc: "2.0",
        result: "0x" + "0".repeat(64),
      }));
      await route.fulfill({ json: Array.isArray(body) ? result : result[0] });
    },
  );
  await page.route(
    `https://data.cs2chickens.fun/wallets/${address}.json`,
    (route) =>
      route.fulfill({
        json: {
          address,
          updatedAt: state.updatedAt,
          eligibility: true,
          chickStreak: 0,
          holdings: [],
          chickWeightWei: "0",
          roundWeight: {},
          carryover: [],
          received: [],
          receivedHasMore: true,
          receivedPages: {
            pageSize: 100,
            totalPages: 3,
            basePath: `wallets/${address}/received/`,
            ready: true,
          },
        },
      }),
  );
  await page.route(
    `https://data.cs2chickens.fun/wallets/${address}/received/*.json`,
    (route) =>
      route.request().url().endsWith("/0.json")
        ? route.fulfill({
            json: {
              address,
              page: 0,
              pageSize: 100,
              received: [
                {
                  round: 1,
                  category: "family",
                  amountWei: "1500000000000000000",
                  tx,
                },
              ],
            },
          })
        : route.fulfill({ status: 404 }),
  );
  await page.goto("/check/");
  await page.getByRole("textbox").fill(address);
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await page.getByLabel("Payment archive").selectOption("0");
  await expect(page.locator(".wallet-ledger")).toContainText("1.5");
  await expect(page.locator('.wallet-ledger a[href*="/tx/"]')).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/${tx}`,
  );
  await page.getByLabel("Payment archive").selectOption("1");
  await expect(page.locator(".wallet-ledger")).toContainText(
    "No confirmed holder payments",
  );
  await expect(page.locator(".archive-picker [role=alert]")).toHaveCount(0);
});
