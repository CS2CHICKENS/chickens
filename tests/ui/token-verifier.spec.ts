import { test, expect } from "@playwright/test";
import { config } from "../../packages/core/src/index";
import { emptyState } from "../../packages/core/src/state";

const unknown = "0x1111111111111111111111111111111111111111";
function published() {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.headBlock = 12345;
  state.stale = false;
  state.tokens = config.tokens.map((token) => ({
    id: token.id,
    address: token.address,
    family: "family" in token ? token.family : undefined,
    priceEth: 0,
    priceUsd: null,
    marketCapUsd: null,
    volumeRoundEth: 0,
    holders: 0,
    graduationProgress: 0,
  }));
  return state;
}

test("all five base addresses work offline with exact token and market links", async ({
  page,
}) => {
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ status: 404, body: "{}" }),
  );
  const rpcRequests: string[] = [];
  page.on("request", (request) => {
    if (/robinhood\.drpc|rpc\.mainnet\.chain\.robinhood/.test(request.url()))
      rpcRequests.push(request.url());
  });
  await page.goto("/verify/");
  await expect(page).toHaveTitle(/Check a token/);
  for (const token of config.tokens) {
    await page
      .getByLabel("CONTRACT ADDRESS", { exact: true })
      .fill("  " + token.address.toLowerCase() + "  ");
    await page
      .getByRole("button", { name: "CHECK ADDRESS", exact: true })
      .click();
    const result = page.getByRole("status", { name: "Address check result" });
    await expect(
      result.getByRole("heading", { name: token.symbol, exact: true }),
    ).toBeVisible();
    await expect(result).toContainText("listed CS2 Chickens base token");
    await expect(
      result.getByRole("link", { name: "TOKEN DETAILS" }),
    ).toHaveAttribute("href", "/tokens/" + token.id + "/");
    await expect(
      result.getByRole("link", { name: "OPEN PONS" }),
    ).toHaveAttribute(
      "href",
      "https://www.ponsfamily.com/launchpad/" + token.address,
    );
    await expect(
      result.getByRole("link", { name: "EXPLORER" }),
    ).toHaveAttribute(
      "href",
      "https://robinhoodchain.blockscout.com/token/" + token.address,
    );
    await expect(result.locator("code")).toHaveText(token.address);
  }
  expect(rpcRequests).toEqual([]);
  await expect(
    page.getByRole("button", { name: /connect wallet/i }),
  ).toHaveCount(0);
});

test("only registered variants match, while a hatch alone does not identify a token", async ({
  page,
}) => {
  const state = published();
  state.history.hatches = [
    {
      round: 1,
      family: "catalana",
      variant: "catalana-black",
      block: 12000,
      hash: "0x" + "1".repeat(64),
      tokenAddress: unknown,
    },
  ];
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/verify/");
  const input = page.getByLabel("CONTRACT ADDRESS", { exact: true });
  await input.fill(unknown);
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Not in the published registry" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Address check result" }),
  ).toContainText("12,345");
  await expect(page.getByRole("link", { name: "OPEN PONS" })).toHaveCount(0);
  state.tokens.push({
    ...state.tokens[2],
    id: "catalana-black",
    address: unknown,
    family: "catalana",
  });
  await page.reload();
  await input.fill(unknown);
  await input.press("Enter");
  const result = page.getByRole("status", { name: "Address check result" });
  await expect(result).toContainText("listed CS2 Chickens launched variant");
  await expect(result).toContainText("CATALANA FAMILY");
  await expect(
    result.getByRole("link", { name: "TOKEN DETAILS" }),
  ).toHaveAttribute("href", "/tokens/catalana-black/");
  await expect(result.getByRole("link", { name: "OPEN PONS" })).toHaveAttribute(
    "href",
    "https://www.ponsfamily.com/launchpad/" + unknown,
  );
  await result.getByRole("link", { name: "TOKEN DETAILS" }).click();
  await expect(page).toHaveURL(/\/tokens\/catalana-black\/$/);
});

test("invalid input and missing or stale registries never produce a false match", async ({
  page,
}) => {
  let state = published();
  state.tokens.push({
    ...state.tokens[2],
    id: "catalana-black",
    address: unknown,
    family: "catalana",
  });
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/verify/");
  const input = page.getByLabel("CONTRACT ADDRESS", { exact: true });
  for (const value of [
    "CHICK",
    "0x1234",
    "https://www.ponsfamily.com/launchpad/" + unknown,
    "",
  ]) {
    await input.fill(value);
    await input.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Enter a complete contract address" }),
    ).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
  }
  await page.getByRole("button", { name: "Check CHICK example" }).click();
  await expect(
    page.getByRole("status", { name: "Address check result" }),
  ).toContainText("ADDRESS MATCH");
  await input.fill(unknown);
  await expect(
    page.getByRole("status", { name: "Address check result" }),
  ).toHaveCount(0);
  for (const kind of [
    "stale",
    "incomplete",
    "demo",
    "wrong-family",
    "duplicate",
  ] as const) {
    state = published();
    state.tokens.push({
      ...state.tokens[2],
      id: "catalana-black",
      address: unknown,
      family: "catalana",
    });
    if (kind === "stale") state.updatedAt -= 1000;
    if (kind === "incomplete") state.tokens = state.tokens.slice(1);
    if (kind === "demo") state.mode = "demo";
    if (kind === "wrong-family") state.tokens.at(-1)!.family = "silkie";
    if (kind === "duplicate")
      state.tokens.push({
        ...state.tokens.at(-1)!,
        address: "0x2222222222222222222222222222222222222222",
      });
    await page.reload();
    await input.fill(unknown);
    await input.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Live registry unavailable" }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Address check result" }),
    ).not.toContainText("ADDRESS MATCH");
    await expect(page.getByRole("link", { name: "OPEN PONS" })).toHaveCount(0);
  }
});

test("address checks fit narrow screens and unavailable data stays inconclusive", async ({
  page,
}) => {
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({ status: 404, body: "{}" }),
  );
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/verify/");
    await page.getByRole("button", { name: "Check CHICK example" }).click();
    await expect(
      page.getByRole("status", { name: "Address check result" }),
    ).toContainText("ADDRESS MATCH");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width !== 320)
      await page.screenshot({
        path: "private/verification/token-verifier-" + width + ".png",
        fullPage: true,
      });
    await page.getByLabel("CONTRACT ADDRESS", { exact: true }).fill(unknown);
    await page
      .getByRole("button", { name: "CHECK ADDRESS", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Live registry unavailable" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
