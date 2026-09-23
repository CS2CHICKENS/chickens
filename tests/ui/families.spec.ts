import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const base = JSON.parse(
  readFileSync("private/verification/demo-state.json", "utf8"),
);

test("a hatched variant joins its family and contributes after launch", async ({
  page,
}) => {
  const state = structuredClone(base);
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.round.volumeByFamily.catalana = "8000000000000000000";
  state.round.volumeByToken = {
    catalana: "5000000000000000000",
    "catalana-black": "3000000000000000000",
  };
  state.history.hatches = [
    {
      round: 1,
      family: "catalana",
      variant: "catalana-black",
      block: 116,
      hash: "0x" + "1".repeat(64),
      tokenAddress: null,
    },
  ];
  await page.route("https://data.cs2chickens.fun/state.json", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify(state) }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/rounds/");
  const member = page.locator(
    '[data-family="catalana"] [data-token="catalana-black"]',
  );
  await expect(member).toContainText("HATCHED · ROUND 1");
  await expect(member).toContainText("AWAITING LAUNCH");
  state.tokens.push({
    id: "catalana-black",
    family: "catalana",
    address: "0x" + "1".repeat(40),
    priceEth: 0.001,
    priceUsd: null,
    marketCapUsd: null,
    volumeRoundEth: 3,
    holders: 1,
    graduationProgress: 0,
  });
  await expect(member).toContainText("3 ETH", { timeout: 10000 });
  await expect(
    page.locator('[data-family="catalana"] .battle-total'),
  ).toContainText("8 ETH");
  await expect(page.locator('[data-token="catalana"]')).toContainText("5 ETH");
  await page
    .locator("summary")
    .filter({ hasText: "Does only the original chicken count?" })
    .click();
  await expect(page.locator("details[open]")).toContainText(
    "You do not have to hold the original token",
  );
});

test("fee collection and developer allocation are explained separately", async ({
  page,
}) => {
  await page.route("https://data.cs2chickens.fun/**", (r) =>
    r.fulfill({ status: 404, body: "{}" }),
  );
  await page.goto("/feed/");
  await expect(page.locator(".fee-collection")).toContainText(
    "100% of creator fees",
  );
  await expect(page.locator(".fee-collection a")).toHaveAttribute(
    "href",
    /0x9C05Be9E7017f369169E57E2e0680ca3Ec8a871F/,
  );
  await expect(page.locator(".developer-share")).toContainText("NOT INDEXED");
  await page
    .locator("summary")
    .filter({ hasText: "What does “Developer fees paid” mean?" })
    .click();
  await expect(page.locator("details[open]")).toContainText(
    "rather than claiming that no developer transfers have occurred",
  );
});

test("kitchen uses separate shells and yolk, replays and respects reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kitchen/");
  const scene = page.locator(".kitchen-cinematic");
  await scene.scrollIntoViewIfNeeded();
  await expect(scene.locator(".cook-part")).toHaveCount(3);
  await expect(scene).toHaveAttribute("data-phase", "cooked", {
    timeout: 8000,
  });
  await page.getByRole("button", { name: "REPLAY COOK" }).click();
  await expect(scene).toHaveAttribute("data-phase", "drop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(scene).toHaveAttribute("data-phase", "ready");
  await expect(page.getByRole("button", { name: "REPLAY COOK" })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
