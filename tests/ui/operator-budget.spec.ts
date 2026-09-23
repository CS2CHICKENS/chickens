import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { config, WAD, type Round } from "../../packages/core/src/index";
import { buildManifest } from "../../packages/core/src/engine";
import { createOperatorServer } from "../../scripts/operator";
import {
  OperatorTransactions,
  type Proposal,
} from "../../scripts/operator-transactions";
import type { PreparedRound } from "../../scripts/operator-plan";
import { toHex, type Address, type Hex } from "viem";

test.describe.configure({ mode: "serial" });

const proof = ("0x" + "4".repeat(64)) as Hex,
  endHash = ("0x" + "2".repeat(64)) as Hex;
const round: Round = {
  id: 4,
  startBlock: 10,
  feeStartBlock: 10,
  startTs: 100,
  endBlock: 20,
  endTs: 200,
  endLogIndex: 1,
  threshold: 100n * WAD,
  volumes: { catalana: 100n * WAD },
  familyVolumes: { catalana: 100n * WAD },
  winner: "catalana",
  reason: "threshold",
  creatorFeeWei: 4n * WAD,
  preStartCreatorFeeWei: 0n,
  pot: 2n * WAD,
};
const manifest = buildManifest(
  round,
  {
    family: {
      "0x1111111111111111111111111111111111111111": (12n * WAD) / 10n - 17n,
      "0x2222222222222222222222222222222222222222": 17n,
    },
    chick: { "0x3333333333333333333333333333333333333333": WAD },
    streaks: {},
  },
  [],
  (3n * WAD) / 100n,
  15,
  [],
);

async function harness(page: Page) {
  const directory = await mkdtemp("private/operator-budget-test-");
  const rpc = {
    getBalance: async () => 10n * WAD,
  } as unknown as OperatorTransactions["rpc"];
  const service = new OperatorTransactions({ directory, rpc });
  const state = {
    fail: false,
    nextCalls: 0,
    cancellations: 0,
    nextGate: undefined as Promise<void> | undefined,
    proposal: null as Proposal | null,
  };
  service.prepare = async (selectedRound) => {
    service.prepared = undefined;
    if (state.fail || selectedRound !== 4)
      throw Error("Independent round verification failed");
    service.prepared = {
      rpc,
      tokens: [],
      manifest,
      manifests: [manifest],
      proof,
      endHash,
    } as PreparedRound;
    return {
      round: selectedRound,
      manifest,
      proof,
      endHash,
      batches: 1,
      feedBalanceWei: (
        await rpc.getBalance({
          address: config.wallets.feed as Address,
        })
      ).toString(),
    };
  };
  service.nextSettlement = async () => {
    state.nextCalls++;
    await state.nextGate;
    return state.proposal;
  };
  service.cancel = async () => {
    state.cancellations++;
  };
  const port = 18790,
    origin = "http://127.0.0.1:" + port,
    server = createOperatorServer(service, port);
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  await page.addInitScript((feed) => {
    const calls: string[] = [];
    (window as any).walletCalls = calls;
    const provider = {
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === "eth_requestAccounts") return [feed];
        if (method === "eth_chainId") return "0x1237";
        if (method === "eth_getBalance") return "0x8ac7230489e80000";
        throw Error("Unexpected wallet method in review-only test");
      },
    };
    window.addEventListener("eip6963:requestProvider", () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: { info: { rdns: "io.rabby" }, provider },
        }),
      ),
    );
  }, config.wallets.feed);
  await page.goto(origin);
  await expect(page.locator("#status")).toContainText("Ready.");
  const session = await page
    .locator('meta[name="operator-session"]')
    .getAttribute("content");
  return {
    state,
    service,
    post: (path: string, body: unknown) =>
      page.request.post(origin + "/api/" + path, {
        headers: {
          origin,
          "content-type": "application/json",
          "x-operator-session": session!,
        },
        data: body,
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("the verified round fixes exact allocations despite extra Feed ETH and invalidates stale plans", async ({
  page,
}) => {
  const app = await harness(page);
  try {
    await page
      .getByRole("button", { name: "Connect Rabby", exact: true })
      .click();
    await expect(page.locator("#account")).toHaveText(config.wallets.feed!);
    await page.getByLabel("Round number").fill("4");
    const prepared = page.waitForResponse((response) =>
      response.url().endsWith("/api/prepare"),
    );
    await page.getByRole("button", { name: "Recompute and verify" }).click();
    expect((await (await prepared).json()).feedBalanceWei).toBe(
      (10n * WAD).toString(),
    );
    await expect(page.locator("#budget-title")).toHaveText(
      "ROUND 4 · VERIFIED BUDGET",
    );
    const expected = [
      ["Verified creator fees", "4 ETH"],
      ["Developer allocation", "2 ETH"],
      ["Community allocation for this round", "2 ETH"],
      [
        "Holder batches scheduled (including carried rewards)",
        "1.399999999999999983 ETH",
      ],
      ["Buyback and burn budget", "0.6 ETH"],
      ["Small rewards carried forward", "0.000000000000000017 ETH"],
    ];
    for (const [label, amount] of expected)
      await expect(
        page
          .locator("#budget-amounts dt")
          .filter({ hasText: label })
          .locator("xpath=following-sibling::dd[1]"),
      ).toHaveText(amount);
    await expect(page.locator("#budget")).toContainText(
      "Extra ETH in Feed never increases this allocation.",
    );
    await expect(page.locator("#settle")).toBeEnabled();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.locator("#budget").screenshot({
        path: "private/verification/operator-budget-" + width + ".png",
      });
    }
    await page.getByLabel("Round number").fill("5");
    await expect(page.locator("#budget")).toBeHidden();
    await expect(page.locator("#settle")).toBeDisabled();
    await expect(page.locator("#plan")).toHaveText("No round verified.");
    await page.getByLabel("Round number").fill("4");
    await page.getByRole("button", { name: "Recompute and verify" }).click();
    await expect(page.locator("#settle")).toBeEnabled();
    app.state.fail = true;
    await page.getByRole("button", { name: "Recompute and verify" }).click();
    await expect(page.locator("#status")).toContainText(
      "Independent round verification failed",
    );
    await expect(page.locator("#budget")).toBeHidden();
    await expect(page.locator("#settle")).toBeDisabled();
    expect(app.state.nextCalls).toBe(0);
    expect(
      await page.evaluate(() => (window as any).walletCalls),
    ).not.toContain("eth_sendTransaction");
  } finally {
    await app.close();
  }
});

test("the local API binds settlement to the current verified round and proof", async ({
  page,
}) => {
  const app = await harness(page);
  try {
    expect(
      (await app.post("next", { mode: "settle", round: 4, proof })).status(),
    ).toBe(400);
    expect((await app.post("prepare", { round: 4 })).status()).toBe(200);
    for (const body of [
      { mode: "settle", round: 3, proof },
      { mode: "settle", round: 5, proof },
      { mode: "settle", round: "4", proof },
      { mode: "settle", round: 4, proof: endHash },
      { mode: "settle", round: 4 },
      { mode: "settle", proof },
    ]) {
      const response = await app.post("next", body);
      expect(response.status()).toBe(400);
      expect((await response.json()).error).toContain("Recompute and verify");
    }
    expect(app.state.nextCalls).toBe(0);
    expect(
      (await app.post("next", { mode: "settle", round: 4, proof })).status(),
    ).toBe(200);
    expect(app.state.nextCalls).toBe(1);
    app.state.fail = true;
    expect((await app.post("prepare", { round: 4 })).status()).toBe(400);
    expect(
      (await app.post("next", { mode: "settle", round: 4, proof })).status(),
    ).toBe(400);
    expect(app.state.nextCalls).toBe(1);
  } finally {
    await app.close();
  }
});

test("the round cannot change while its settlement proposal is being prepared", async ({
  page,
}) => {
  const app = await harness(page);
  let release = () => {};
  try {
    app.state.nextGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.state.proposal = {
      id: "round-4-batch-0",
      label: "Pay holder batch 1",
      from: config.wallets.feed as Address,
      to: "0x4444444444444444444444444444444444444444",
      data: "0x1234",
      value: toHex(
        manifest.payouts.reduce((sum, row) => sum + BigInt(row.amountWei), 0n),
      ),
      gas: "0x5208",
      maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x1",
      nonce: "0x0",
      chainId: "0x1237",
      preparedBlock: 20,
      proof,
    };
    await page.getByLabel("Round number").fill("4");
    await page.getByRole("button", { name: "Recompute and verify" }).click();
    await expect(page.locator("#settle")).toBeEnabled();
    await page
      .getByRole("button", { name: "Start / resume settlement" })
      .click();
    await expect.poll(() => app.state.nextCalls).toBe(1);
    await expect(page.getByLabel("Round number")).toBeDisabled();
    await page
      .getByRole("button", { name: "Stop after current transaction" })
      .click();
    await expect(page.getByLabel("Round number")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Recompute and verify" }),
    ).toBeDisabled();
    release();
    await expect(page.locator("#review")).toBeVisible();
    await expect(page.locator("#transaction")).toContainText("round-4-batch-0");
    await expect(page.getByLabel("Round number")).toBeDisabled();
    await page.getByRole("button", { name: "Cancel this request" }).click();
    await expect(page.locator("#review")).toBeHidden();
    await expect(page.getByLabel("Round number")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Recompute and verify" }),
    ).toBeEnabled();
    expect(app.state.cancellations).toBe(1);
    app.state.proposal = null;
    await page
      .getByRole("button", { name: "Start / resume settlement" })
      .click();
    await expect(page.locator("#status")).toContainText("Settlement complete.");
    await expect(page.getByLabel("Round number")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Recompute and verify" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() => (window as any).walletCalls),
    ).not.toContain("eth_sendTransaction");
  } finally {
    release();
    await app.close();
  }
});
