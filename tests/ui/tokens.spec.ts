import { test, expect } from "@playwright/test";
import { emptyState } from "../../packages/core/src/state";
import { config } from "../../packages/core/src/index";
function fixture() {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.stale = false;
  state.headBlock = 12345;
  state.round.threshold = "100000000000000000000";
  state.tokens = config.tokens.map((t) => ({
    id: t.id,
    address: t.address,
    family: "family" in t ? t.family : undefined,
    priceEth: 0.001,
    priceUsd: null,
    marketCapUsd: null,
    volumeRoundEth: 3,
    holders: 12,
    graduationProgress: 0.25,
  }));
  return state;
}
test("inventory opens token dossiers with exact market destinations and project X", async ({
  page,
}) => {
  const state = fixture();
  await page.route("https://data.cs2chickens.fun/state.json", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify(state) }),
  );
  await page.goto("/inventory/");
  await page
    .locator(".item")
    .filter({ has: page.getByRole("heading", { name: "CHICK", exact: true }) })
    .getByRole("link", { name: "TOKEN DETAILS" })
    .click();
  await expect(page).toHaveURL(/\/tokens\/chick\/$/);
  await expect(
    page.getByRole("heading", { name: "CHICK", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".token-role").first()).toContainText("10%");
  await expect(
    page.locator("footer").getByRole("link", { name: "@CS2Chickens on X" }),
  ).toHaveAttribute("href", "https://x.com/CS2Chickens");
  for (const token of config.tokens) {
    await page.goto("/tokens/" + token.id + "/");
    await expect(page.getByRole("link", { name: "OPEN PONS" })).toHaveAttribute(
      "href",
      "https://www.ponsfamily.com/launchpad/" + token.address,
    );
    await expect(page.getByRole("link", { name: "GMGN" })).toHaveAttribute(
      "href",
      "https://gmgn.ai/robinhood/token/" + token.address.toLowerCase(),
    );
    await expect(
      page.getByRole("link", { name: "EXPLORER", exact: false }),
    ).toHaveAttribute(
      "href",
      "https://robinhoodchain.blockscout.com/token/" + token.address,
    );
    await expect(
      page.getByRole("region", { name: "Token statistics" }),
    ).toContainText("12");
    await expect(page).toHaveTitle(new RegExp(token.symbol));
  }
});
test("variant dossier exposes market links only after a verified launch", async ({
  page,
}) => {
  const state = fixture();
  await page.route("https://data.cs2chickens.fun/state.json", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify(state) }),
  );
  await page.goto("/tokens/catalana-black/");
  await expect(page.getByText("STILL IN THE EGG.")).toBeVisible();
  await expect(page.getByRole("link", { name: "GMGN" })).toHaveCount(0);
  state.history.hatches = [
    {
      round: 1,
      family: "catalana",
      variant: "catalana-black",
      block: 12000,
      hash: "0x" + "1".repeat(64),
      tokenAddress: null,
    },
  ];
  await page.reload();
  await expect(page.getByText("REVEALED. NOT TRADABLE YET.")).toBeVisible();
  await expect(page.getByRole("link", { name: "GMGN" })).toHaveCount(0);
  const address = "0x1111111111111111111111111111111111111111";
  state.tokens.push({
    ...state.tokens[2],
    id: "catalana-black",
    address,
    family: "catalana",
  });
  await page.reload();
  await expect(page.getByRole("link", { name: "GMGN" })).toHaveAttribute(
    "href",
    "https://gmgn.ai/robinhood/token/" + address,
  );
  await expect(page.locator(".token-siblings a")).toHaveCount(2);
  await expect(page.locator(".token-role").first()).toContainText("60%");
});
test("missing token data stays unknown and dossiers fit mobile and desktop", async ({
  page,
}) => {
  await page.route("https://data.cs2chickens.fun/**", (r) =>
    r.fulfill({ status: 404, body: "{}" }),
  );
  await page.route(
    /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org)\//,
    (r) => r.abort(),
  );
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of [
      "chick",
      "egg",
      "catalana",
      "polish-brown-with-black-wing-tips",
    ]) {
      await page.goto("/tokens/" + id + "/");
      await expect(page.locator("h1")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (id === "egg") {
        await expect(page.locator(".token-facts")).toContainText(
          config.wallets.burn!,
        );
        await expect(page.locator(".token-stats")).not.toContainText("0 ETH");
      }
      if ((width === 390 || width === 1440) && id === "chick")
        await page.screenshot({
          path: "private/verification/token-chick-" + width + ".png",
          fullPage: true,
        });
    }
  }
});
