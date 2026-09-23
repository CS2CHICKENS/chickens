import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { config, hatch } from "../../packages/core/src/index";
import type { Hex } from "viem";

const base = JSON.parse(
  readFileSync("private/verification/demo-state.json", "utf8"),
);
const blockHash = ("0x" + "1".repeat(64)) as Hex;
function sharedState() {
  const state = structuredClone(base);
  state.updatedAt = Math.floor(Date.now() / 1000);
  const family = config.families[0];
  state.incubators = [
    {
      round: 1,
      status: "hatched",
      family: family.id,
      hatchAt: 1016,
      remaining: family.variants,
      result: {
        variant: hatch(blockHash, family.variants).variant,
        block: 116,
        hash: blockHash,
        tokenAddress: "",
      },
    },
    {
      round: 2,
      status: "incubating",
      family: "polish",
      hatchAt: Math.floor(Date.now() / 1000) + 36000,
      remaining: config.families[1].variants,
      result: null,
    },
  ];
  state.incubator = state.incubators[1];
  return state;
}

for (const reduced of [true, false])
  test(
    "switch between same-block hatches " +
      (reduced ? "with reduced motion" : "with animation"),
    async ({ page }) => {
      const state = structuredClone(base);
      state.updatedAt = Math.floor(Date.now() / 1000);
      state.incubators = config.families.slice(0, 2).map((family, index) => ({
        round: index + 1,
        status: "hatched",
        family: family.id,
        hatchAt: 1016,
        remaining: family.variants,
        result: {
          variant: hatch(blockHash, family.variants).variant,
          block: 116,
          hash: blockHash,
          tokenAddress: "",
        },
      }));
      state.incubator = state.incubators[1];
      await page.emulateMedia({
        reducedMotion: reduced ? "reduce" : "no-preference",
      });

      await page.route("https://data.cs2chickens.fun/state.json", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(state),
        }),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/incubator/");
      const image = page.locator(".nest-chicken img");
      await expect(image).toHaveAttribute(
        "alt",
        state.incubators[1].result.variant.split("-").join(" "),
        { timeout: 6000 },
      );
      for (const index of [0, 1]) {
        await page.getByLabel("ROUND TO VIEW").selectOption(String(index + 1));
        await expect(image).toHaveAttribute(
          "alt",
          state.incubators[index].result.variant.split("-").join(" "),
          { timeout: 6000 },
        );
        await expect(page.locator(".reveal-caption")).toContainText(
          state.incubators[index].family.toUpperCase(),
        );
        await expect(page.locator(".proof")).toContainText("VERIFIED");
      }
    },
  );

test("a shared older hatch opens its proof and remains selected while new eggs arrive", async ({
  page,
  context,
}) => {
  const state = sharedState();
  let requests = 0;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("https://data.cs2chickens.fun/state.json", (route) => {
    requests++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    });
  });
  await page.goto("/incubator/?round=1");
  await expect(page.getByLabel("ROUND TO VIEW")).toHaveValue("1");
  await expect(page.locator(".nest-chicken img")).toHaveAttribute(
    "alt",
    state.incubators[0].result.variant.split("-").join(" "),
  );
  const share = new URL(
    (await page
      .getByRole("link", { name: "SHARE ON X" })
      .getAttribute("href"))!,
  );
  const proofUrl = "https://cs2chickens.fun/incubator/?round=1";
  expect(share.searchParams.get("text")).toContain(proofUrl);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page
    .getByRole("button", { name: "Copy " + proofUrl, exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(proofUrl);
  const observed = requests;
  state.incubators.push({
    ...state.incubators[1],
    round: 3,
    family: "silkie",
    remaining: config.families[2].variants,
  });
  await expect
    .poll(() => requests, { timeout: 10000 })
    .toBeGreaterThan(observed);
  await expect(page.getByLabel("ROUND TO VIEW")).toHaveValue("1");
  await expect(page.locator(".reveal-caption")).toContainText("CATALANA");
  await page.getByLabel("ROUND TO VIEW").selectOption("2");
  await expect(page).toHaveURL(/\/incubator\/\?round=2$/);
  const secondPoll = requests;
  await expect
    .poll(() => requests, { timeout: 10000 })
    .toBeGreaterThan(secondPoll);
  await expect(page.getByLabel("ROUND TO VIEW")).toHaveValue("2");
});

test("unknown and invalid hatch links explain the problem instead of revealing another round", async ({
  page,
}) => {
  const state = sharedState();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  for (const value of ["999", "-1", "invalid", "9007199254740992"]) {
    await page.goto("/incubator/?round=" + value);
    const alert = page.locator(".incubator-page [role=alert]");
    await expect(alert).toContainText(
      value === "999"
        ? "Round 999 has no published egg"
        : "invalid round number",
    );
    await expect(page.locator(".nest-chicken img")).toHaveCount(0);
    await expect(page.locator(".countdown")).toHaveText("STAND BY");
    await expect(page.getByRole("link", { name: "SHARE ON X" })).toHaveCount(0);
    await page.getByLabel("ROUND TO VIEW").selectOption("1");
    await expect(alert).toHaveCount(0);
    await expect(page.locator(".nest-chicken img")).toBeVisible();
    await expect(page).toHaveURL(/\?round=1$/);
  }
});

test("expired incubation waits for a confirmed block and displays its exact UTC deadline", async ({
  page,
}) => {
  const state = sharedState();
  state.incubators[1].hatchAt = Math.floor(Date.now() / 1000) - 10;
  state.incubator = state.incubators[1];
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("https://data.cs2chickens.fun/state.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state),
    }),
  );
  await page.goto("/incubator/?round=2");
  await expect(page.locator(".chamber-label")).toContainText(
    "AWAITING CONFIRMED HATCH BLOCK",
  );
  await expect(page.locator(".countdown")).toContainText("STAND BY");
  await expect(page.locator(".nest-chicken img")).toHaveCount(0);
  const utc = new Date(state.incubators[1].hatchAt * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
  await expect(page.locator(".incubation-deadline")).toContainText(utc);
  await expect(page.locator(".incubation-deadline")).toContainText(
    "does not guarantee an immediate token launch",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "private/verification/incubator-confirmation-320.png",
    fullPage: true,
  });
});
