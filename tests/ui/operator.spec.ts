import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createOperatorServer } from "../../scripts/operator";
import {
  OperatorTransactions,
  type Proposal,
} from "../../scripts/operator-transactions";
import { config } from "../../packages/core/src/index";
import type { Address, Hex } from "viem";
test("Rabby review blocks the wrong account, recovers rejection, and confirms only the reviewed transaction", async ({
  page,
}) => {
  const directory = await mkdtemp("private/operator-ui-test-");
  const service = new OperatorTransactions({ directory });
  const hash = ("0x" + "1".repeat(64)) as Hex;
  const proposal: Proposal = {
    id: "deploy-Split",
    label: "Deploy Split",
    from: config.wallets.feed as Address,
    data: "0x1234",
    value: "0x0",
    gas: "0x5208",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    nonce: "0x0",
    chainId: "0x1237",
    preparedBlock: 1,
    proof: hash,
    deploy: "Split",
  };
  let confirmed = 0,
    cancelled = 0;
  service.nextDeployment = async () => (confirmed ? null : proposal);
  service.cancel = async () => {
    cancelled++;
  };
  service.confirm = async (id, tx) => {
    expect(id).toBe(proposal.id);
    expect(tx).toBe(hash);
    confirmed++;
    return { tx, confirmed: true, gasWei: "1" };
  };
  const port = 18789,
    server = createOperatorServer(service, port);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    await page.addInitScript(
      ({ feed, hash }) => {
        const state = {
          account: "0x2222222222222222222222222222222222222222",
          network: "0x1",
          reject: false,
          sends: [] as unknown[],
        };
        (window as any).testWallet = state;
        const provider = {
          request: async ({ method, params }: any) => {
            if (method === "eth_requestAccounts") return [state.account];
            if (method === "eth_chainId") return state.network;
            if (method === "wallet_switchEthereumChain") {
              state.network = params[0].chainId;
              return null;
            }
            if (method === "eth_sendTransaction") {
              if (state.reject)
                throw Object.assign(new Error("Rejected by user"), {
                  code: 4001,
                });
              state.sends.push(params[0]);
              return hash;
            }
            throw Error("Unexpected wallet method");
          },
        };
        window.addEventListener("eip6963:requestProvider", () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: { info: { rdns: "io.rabby" }, provider },
            }),
          ),
        );
      },
      { feed: config.wallets.feed, hash },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://127.0.0.1:" + port);
    await page.getByRole("button", { name: "Review deployment" }).click();
    await expect(page.locator("#transaction")).toContainText(
      config.wallets.feed!,
    );
    await page.getByRole("button", { name: "Request Rabby signature" }).click();
    await expect(page.locator("#status")).toContainText(
      "Select the required signing account",
    );
    expect(
      await page.evaluate(() => (window as any).testWallet.sends.length),
    ).toBe(0);
    await page.evaluate((feed) => {
      (window as any).testWallet.account = feed;
      (window as any).testWallet.reject = true;
    }, config.wallets.feed);
    await page.getByRole("button", { name: "Request Rabby signature" }).click();
    await expect(page.locator("#review")).toBeHidden();
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
    await page.evaluate(() => ((window as any).testWallet.reject = false));
    await page.getByRole("button", { name: "Review deployment" }).click();
    await page.getByRole("button", { name: "Request Rabby signature" }).click();
    await expect(page.locator("#status")).toContainText(
      "Both deployments are confirmed",
    );
    expect(confirmed).toBe(1);
    const sent = await page.evaluate(() => (window as any).testWallet.sends);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toBe("0x1234");
    expect(sent[0].chainId).toBe("0x1237");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "private/verification/operator-mobile.png",
      fullPage: true,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
