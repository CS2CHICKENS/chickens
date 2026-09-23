import { test, expect } from "@playwright/test";
import { emptyState } from "../../packages/core/src/state";
import { parseEther } from "viem";

function fixture() {
  const state = structuredClone(emptyState);
  state.mode = "monitoring";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.headBlock = 110;
  state.stale = false;
  state.feed.preStartCreatorFeeWei = parseEther("2.04").toString();
  state.feed.sources = {
    ready: true,
    fromBlock: 10,
    throughBlock: 110,
    totals: [
      {
        token: "egg",
        volumeWei: parseEther("100").toString(),
        creatorFeeWei: parseEther("1.7").toString(),
      },
      {
        token: "chick",
        volumeWei: parseEther("20").toString(),
        creatorFeeWei: parseEther("0.34").toString(),
      },
      { token: "catalana", volumeWei: "0", creatorFeeWei: "0" },
      { token: "polish", volumeWei: "0", creatorFeeWei: "0" },
      { token: "silkie", volumeWei: "0", creatorFeeWei: "0" },
    ],
  };
  return state;
}

for (const width of [360, 1440]) {
  test(`EGG and CHICK contributions are visible before family competition at ${width}px`, async ({
    page,
  }) => {
    const state = fixture();
    await page.setViewportSize({ width, height: 960 });
    await page.route("https://data.cs2chickens.fun/state.json", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(state),
      }),
    );
    await page.goto("/feed/");
    const section = page.getByRole("region", {
      name: "EVERY TOKEN FILLS THE FEED",
    });
    await expect(section.locator(".source-summary")).toContainText("120 ETH");
    const egg = section.locator(".source-token").filter({
      has: page.getByRole("heading", { name: "EGG", exact: true }),
    });
    await expect(egg).toContainText("100 ETH");
    await expect(egg).toContainText("1.7 ETH");
    await expect(egg).toContainText("FUNDS THE FEED");
    await expect(egg.locator("dl > div").nth(1)).toContainText("—");
    await expect(section.locator(".source-reserve")).toContainText("1.02 ETH");
    await expect(section).toContainText("blocks 10–110");
    await expect(section.getByRole("link", { name: /EGG/ })).toHaveAttribute(
      "href",
      "/tokens/egg/",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await section.screenshot({
      path: `private/verification/feed-sources-${width}.png`,
    });
  });
}

test("family quota remains separate from all-token fees and missing history stays unknown", async ({
  page,
}) => {
  const state = fixture();
  state.mode = "live";
  state.round.volumeByToken = {
    egg: parseEther("10").toString(),
    chick: parseEther("2").toString(),
    catalana: parseEther("1.5").toString(),
  };
  state.round.volumeByFamily = { catalana: parseEther("1.5").toString() };
  state.round.threshold = parseEther("100").toString();
  state.round.progress = 0.015;
  state.feed.sources!.totals[0].creatorFeeWei = null;
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/feed/");
  const section = page.locator(".feed-sources");
  const egg = section.locator(".source-token").first();
  await expect(egg.locator("dl > div").nth(1)).toContainText("10 ETH");
  await expect(egg.locator("dl > div").nth(2)).toContainText("—");
  await expect(section.locator(".source-reserve")).toHaveCount(0);
  await section.getByText("Does buying EGG count", { exact: false }).click();
  await expect(section.locator(".explain-body")).toBeVisible();
  await expect(section.locator(".explain-body")).toContainText(
    "Only family-token volume advances",
  );
  state.feed.sources = {
    ready: false,
    fromBlock: 10,
    throughBlock: null,
    totals: [],
  };
  state.stale = true;
  await expect(section.locator(".source-summary .digits").first()).toHaveText(
    "—",
    { timeout: 12000 },
  );
  await expect(section).toContainText("newer trades may not appear yet");
});

test("a newly opened second round never shows the first-round reserve or unlimited timeout", async ({
  page,
}) => {
  const state = fixture();
  state.mode = "live";
  state.round.id = 2;
  state.round.startBlock = 111;
  state.round.endsBy = 0;
  state.round.threshold = parseEther("100").toString();
  state.feed.preStartCreatorFeeWei = null;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/feed/");
  const section = page.locator(".feed-sources");
  await expect(section.locator(".source-summary")).toContainText("120 ETH");
  await expect(section.locator(".source-reserve")).toHaveCount(0);
  await expect(
    section.locator(".source-token").first().locator("dl > div").nth(1),
  ).toContainText("0 ETH");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  state.mode = "monitoring";
  await page.reload();
  await expect(section.locator(".source-summary")).toContainText("120 ETH");
  await expect(section.locator(".source-reserve")).toHaveCount(0);
  state.mode = "live";
  await page.goto("/rounds/");
  await expect(page.locator(".round-hud")).toContainText("ROUND 02");
  await expect(page.locator(".round-hud")).toContainText("THE RACE IS ON");
  await expect(page.locator(".round-hud .timeout")).toContainText("--:--:--");
  await expect(page.locator(".round-hud .timeout")).not.toContainText(
    "NO DEADLINE",
  );
});
