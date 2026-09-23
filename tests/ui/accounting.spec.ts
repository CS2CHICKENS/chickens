import { test, expect } from "@playwright/test";
import { emptyState, type PublicState } from "../../packages/core/src/state";

const now = () => Math.floor(Date.now() / 1000);
function fixture(): PublicState {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.updatedAt = now();
  state.stale = false;
  state.headBlock = 100;
  state.round.threshold = "1000000000000000000";
  state.round.endsBy = now() + 3600;
  return state;
}
const tx = "0x" + "a".repeat(64);
const variantAddress = "0x" + "b".repeat(40);

test("initial data failure is explicit and unknown amounts recover after retry", async ({
  page,
}) => {
  let available = false;
  const state = fixture();
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    available
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(state),
        })
      : route.fulfill({ status: 404, body: "{}" }),
  );
  await page.goto("/feed/");
  await expect(page.getByRole("status")).toContainText(
    "Public data is unavailable",
  );
  await expect(page.locator(".feed-overview .digits").first()).toContainText(
    "—",
  );
  await expect(page.locator(".fee-accounting")).toContainText("NOT INDEXED");
  available = true;
  await expect(page.locator(".status-strip")).toContainText(
    "SEASON 01 · LIVE",
    { timeout: 10000 },
  );
  await expect(page.locator(".delay")).toHaveCount(0);
});

test("stalled initial request times out and retries", async ({ page }) => {
  let requests = 0;
  let available = false;
  await page.clock.install();
  await page.route("https://data.cs2chickens.fun/state.json", async (route) => {
    requests++;
    if (available)
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(fixture()),
      });
  });
  await page.goto("/feed/", { waitUntil: "domcontentloaded" });
  await expect.poll(() => requests).toBeGreaterThan(0);
  await page.clock.fastForward(11000);
  await expect(page.getByRole("status")).toContainText(
    "Public data is unavailable",
  );
  available = true;
  await page.clock.fastForward(7000);
  await expect(page.locator(".status-strip")).toContainText("SEASON 01 · LIVE");
});

test("monitoring never claims an active round and supply is authoritative", async ({
  page,
}) => {
  const state = fixture();
  state.mode = "monitoring";
  state.kitchen.supplyLeftWei = "900000000000000000000000000";
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/");
  await expect(page.locator(".status-strip")).toContainText(
    "LIVE MARKETS · ROUNDS NOT ACTIVATED",
  );
  await expect(page.locator(".round-hud")).toContainText(
    "ROUNDS NOT ACTIVATED",
  );
  await expect(page.locator(".round-hud")).not.toContainText("THE RACE IS ON");
  await page.goto("/kitchen/");
  await expect(page.locator(".kitchen-hero")).toContainText("900,000,000");
});

test("fee stages and holder payment receipts are distinct", async ({
  page,
}) => {
  const state = fixture();
  Object.assign(state.feed, {
    generatedWei: "17000000000000000",
    collectedWei: "10000000000000000",
    claimableWei: "7000000000000000",
    feeAccountingStartBlock: 90,
  });
  state.history.rounds = [
    {
      id: 1,
      winner: "catalana",
      potWei: "8500000000000000",
      endReason: "threshold",
      endBlock: 98,
      payoutHash: "0x" + "f".repeat(64),
      accountingVerified: true,
      settlementStatus: "partial",
      payoutTransactions: [tx],
    },
  ];
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/feed/");
  await expect(page.locator(".fee-accounting")).toContainText("0.017 ETH");
  await expect(page.locator(".fee-accounting")).toContainText("0.007 ETH");
  await expect(page.locator(".fee-accounting")).toContainText("0.01 ETH");
  await expect(page.locator(".fee-accounting")).toContainText("block 90");
  await expect(page.locator("table")).toContainText("SETTLEMENT IN PROGRESS");
  await expect(page.locator(".receipt-links a")).toHaveAttribute(
    "href",
    "https://robinhoodchain.blockscout.com/tx/" + tx,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a hatched variant awaits its official launch in inventory", async ({
  page,
}) => {
  const state = fixture();
  state.history.hatches = [
    {
      round: 1,
      family: "catalana",
      variant: "catalana-black",
      block: 99,
      hash: "0x" + "1".repeat(64),
      tokenAddress: null,
    },
  ];
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.route(
    /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
    (route) => route.abort(),
  );
  await page.goto("/inventory/catalana/");
  const card = page
    .locator(".item")
    .filter({ has: page.locator("h2", { hasText: /^BLACK$/ }) });
  await expect(card).toContainText("AWAITING OFFICIAL LAUNCH");
  await expect(card).not.toContainText("AWAITING A HATCH");
  await expect(card.locator("img")).not.toHaveAttribute("src", /locked/);
});

test("earlier incubations remain selected when another egg is incubating", async ({
  page,
}) => {
  const state = fixture();
  state.incubators = [
    {
      round: 1,
      status: "incubating",
      family: "catalana",
      hatchAt: now() + 10,
      remaining: ["catalana-black"],
      result: null,
    },
    {
      round: 2,
      status: "incubating",
      family: "polish",
      hatchAt: now() + 21610,
      remaining: ["polish-blue"],
      result: null,
    },
  ];
  state.incubator = state.incubators[1];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/incubator/");
  await expect(page.getByLabel("ROUND TO VIEW")).toHaveValue("1");
  await expect(
    page
      .getByRole("region", { name: "Upcoming chicken reveals" })
      .getByRole("button"),
  ).toHaveCount(2);
  await expect(
    page.getByText("Incubation does not pause the race.", { exact: false }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "private/verification/incubations-mobile.png",
    fullPage: true,
  });
  state.incubators[0].status = "hatched";
  state.incubators[0].result = {
    variant: "catalana-black",
    block: 100,
    hash: "0x" + "1".repeat(64),
    tokenAddress: "",
  };
  await expect(page.locator(".nest-chicken img")).toHaveAttribute(
    "alt",
    "catalana black",
    { timeout: 10000 },
  );
  await expect(page.getByLabel("ROUND TO VIEW")).toHaveValue("1");
  await page.getByLabel("ROUND TO VIEW").selectOption("2");
  await expect(page.locator(".chamber-label")).toContainText(
    "ROUND 2 · POLISH FAMILY",
  );
  await expect(page.locator(".chamber-label")).toContainText(
    "INCUBATION IN PROGRESS",
  );
});

test("wallet checks include launched variants and render monetary units and receipts", async ({
  page,
}) => {
  const state = fixture();
  state.tokens = [
    {
      id: "catalana-black",
      address: variantAddress,
      family: "catalana",
      priceEth: 0.001,
      priceUsd: null,
      marketCapUsd: null,
      volumeRoundEth: 0,
      holders: 1,
      graduationProgress: 0,
    },
  ];
  const wallet = "0x" + "2".repeat(40);
  const calls: string[] = [];
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.route(
    /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
    async (route) => {
      const request = route.request().postDataJSON();
      const rows = Array.isArray(request) ? request : [request];
      for (const row of rows)
        if (row.params?.[0]?.to) calls.push(row.params[0].to);
      const response = rows.map((row: { id: number }) => ({
        id: row.id,
        jsonrpc: "2.0",
        result: "0x" + (10n ** 18n).toString(16).padStart(64, "0"),
      }));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(request) ? response : response[0]),
      });
    },
  );
  await page.route("https://data.cs2chickens.fun/wallets/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        address: wallet,
        updatedAt: now(),
        round: 2,
        chickStreak: 2,
        eligibility: true,
        holdings: [
          { token: "catalana-black", balanceWei: "1000000000000000000" },
        ],
        chickWeightWei: "2000000000000000000",
        roundWeight: { catalana: "500000000000000000" },
        carryover: [
          { round: 1, category: "family", amountWei: "1000000000000" },
        ],
        received: [
          { round: 1, category: "chick", amountWei: "1000000000000000", tx },
        ],
      }),
    }),
  );
  await page.goto("/check/");
  await expect(page.locator(".status-strip")).toContainText("SEASON 01 · LIVE");
  await page.getByRole("textbox").fill(wallet);
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await expect(page.locator(".wallet-ledger")).toContainText("0.5 ETH");
  await expect(page.locator(".wallet-ledger")).toContainText("0.000001");
  await expect(page.locator("table").first()).toContainText("CATALANA BLACK");
  expect(calls).toContain(variantAddress);
  await expect(page.locator('.wallet-ledger a[href*="/tx/"]')).toHaveAttribute(
    "href",
    "https://robinhoodchain.blockscout.com/tx/" + tx,
  );
  await expect(page.locator(".wallet-ledger")).not.toContainText("balanceWei");
});
