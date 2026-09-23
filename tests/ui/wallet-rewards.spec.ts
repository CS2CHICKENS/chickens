import { test, expect } from "@playwright/test";
import { emptyState } from "../../packages/core/src/state";

test("wallet rewards distinguish published payments, carry-over and confirmed receipts on mobile", async ({
  page,
}) => {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.stale = false;
  state.updatedAt = Math.floor(Date.now() / 1000);
  const address = "0x" + "2".repeat(40);
  const ledger = {
    address,
    updatedAt: state.updatedAt,
    eligibility: true,
    chickStreak: 1,
    holdings: [],
    chickWeightWei: "0",
    roundWeight: {},
    carryover: [
      { round: 2, category: "family", amountWei: "3000000000000000000" },
    ],
    received: [
      {
        round: 1,
        category: "family",
        amountWei: "4000000000000000000",
        tx: "0x" + "a".repeat(64),
      },
    ],
    pendingRewards: {
      ready: true,
      totalWei: "1500000000000000001" as string | null,
      count: 2 as number | null,
      latest: [
        { round: 4, category: "family", amountWei: "1000000000000000001" },
        { round: 3, category: "chick", amountWei: "500000000000000000" },
      ],
      hasMore: false,
    },
  };
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ json: state }),
  );
  await page.route(
    `https://data.cs2chickens.fun/wallets/${address}.json`,
    (route) => route.fulfill({ json: ledger }),
  );
  await page.route(
    /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
    async (route) => {
      const request = route.request().postDataJSON(),
        rows = Array.isArray(request) ? request : [request];
      const result = rows.map((row: { id: number }) => ({
        id: row.id,
        jsonrpc: "2.0",
        result: "0x" + "0".repeat(64),
      }));
      await route.fulfill({
        json: Array.isArray(request) ? result : result[0],
      });
    },
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/check/");
  await page.getByRole("textbox").fill(address);
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  const rewards = page.getByRole("region", {
    name: "Published rewards awaiting payment",
  });
  await expect(rewards.getByTestId("pending-reward-total")).toHaveText(
    "1.500000000000000001 ETH",
  );
  await expect(
    rewards.getByRole("link", { name: "ROUND 4 PLAN" }),
  ).toHaveAttribute("href", "https://data.cs2chickens.fun/payouts/4.json");
  const entries = rewards.getByRole("list", {
    name: "Published payment entries",
  });
  await expect(entries.getByRole("listitem")).toHaveCount(2);
  await expect(entries.getByRole("listitem").first()).toContainText(
    "WINNING FAMILY",
  );
  await expect(entries.getByTestId("pending-entry-amount").first()).toHaveText(
    "1.000000000000000001",
  );
  expect(
    await entries.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        element.scrollWidth <= element.clientWidth &&
        Array.from(element.querySelectorAll("dd,a")).every((child) => {
          const box = child.getBoundingClientRect();
          return (
            box.left >= bounds.left &&
            box.right <= bounds.right &&
            child.scrollWidth <= child.clientWidth
          );
        })
      );
    }),
  ).toBe(true);
  await expect(rewards).toContainText(
    "no claim transaction or wallet connection is required",
  );
  await expect(rewards.getByRole("button")).toHaveCount(0);
  await rewards.screenshot({
    path: "private/verification/wallet-rewards-card-320.png",
  });
  await rewards.locator("summary").click();
  await expect(rewards).toContainText("after 3 rounds");
  await expect(rewards).toContainText(
    "already published payment does not apply that carry-over expiry",
  );
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    items: Array.from(document.querySelectorAll("body *"))
      .filter((element) => !element.closest(".table-wrap"))
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent?.slice(0, 100),
        parent: element.parentElement?.className,
        right: element.getBoundingClientRect().right,
        width: element.getBoundingClientRect().width,
      }))
      .filter((element) => element.right > innerWidth && element.width > 0)
      .slice(0, 20),
  }));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    JSON.stringify(overflow),
  ).toBe(true);
  await page.screenshot({
    path: "private/verification/wallet-pending-rewards-320.png",
    fullPage: true,
  });
  ledger.pendingRewards = {
    ready: false,
    totalWei: null,
    count: null,
    latest: [],
    hasMore: false,
  };
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await expect(rewards.getByTestId("pending-reward-total")).toHaveText(
    "NOT YET VERIFIED",
  );
  await expect(rewards).toContainText("does not mean zero rewards");
  ledger.pendingRewards = {
    ready: true,
    totalWei: "0",
    count: 0,
    latest: [],
    hasMore: false,
  };
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await expect(rewards.getByTestId("pending-reward-total")).toHaveText("0 ETH");
  await expect(rewards).toContainText(
    "No published holder payment is awaiting confirmation",
  );
});

test("large pending lists disclose their cap while preserving the exact total", async ({
  page,
}) => {
  let verified = true;
  const address = "0x" + "3".repeat(40),
    state = structuredClone(emptyState);
  state.mode = "live";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.stale = false;
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ json: state }),
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
          pendingRewards: {
            ready: verified,
            totalWei: verified ? "101000000000000000001" : null,
            count: verified ? 101 : null,
            latest: Array.from({ length: 100 }, (_, i) => ({
              round: 101 - i,
              category: "family",
              amountWei: "1000000000000000000",
            })),
            hasMore: true,
          },
        },
      }),
  );
  await page.route(
    /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
    async (route) => {
      const request = route.request().postDataJSON(),
        rows = Array.isArray(request) ? request : [request];
      const result = rows.map((row: { id: number }) => ({
        id: row.id,
        jsonrpc: "2.0",
        result: "0x" + "0".repeat(64),
      }));
      await route.fulfill({
        json: Array.isArray(request) ? result : result[0],
      });
    },
  );
  await page.goto("/check/");
  await page.getByRole("textbox").fill(address);
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  const rewards = page.getByRole("region", {
    name: "Published rewards awaiting payment",
  });
  await expect(rewards.getByTestId("pending-reward-total")).toHaveText(
    "101.000000000000000001 ETH",
  );
  await expect(rewards).toContainText("latest 100 entries of 101");
  await expect(
    rewards
      .getByRole("list", { name: "Published payment entries" })
      .getByRole("listitem"),
  ).toHaveCount(100);
  await expect(rewards.getByTestId("pending-entry-amount").first()).toHaveText(
    "1",
  );
  await expect(
    rewards.getByRole("link", { name: "ALL PAYOUT PLANS" }),
  ).toHaveAttribute("href", "/feed/");
  verified = false;
  await page.getByRole("button", { name: "CHECK WALLET" }).click();
  await expect(rewards.getByTestId("pending-reward-total")).toHaveText(
    "NOT YET VERIFIED",
  );
  await expect(rewards).toContainText("total is still being indexed");
  await expect(rewards).not.toContainText("verified total includes");
});
