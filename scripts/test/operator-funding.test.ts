import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { config, json } from "../../packages/core/src/index";
import { OperatorTransactions, type Proposal } from "../operator-transactions";
import {
  canonical,
  financialManifest,
  type PreparedRound,
} from "../operator-plan";
import { splitAbi, multisendAbi } from "../../packages/core/src/contracts";
import { tokenAbi } from "../../packages/core/src/chain";

const feed = config.wallets.feed as Address;
const split = "0x2222222222222222222222222222222222222222" as Address;
const multisend = "0x3333333333333333333333333333333333333333" as Address;
const holder = "0x4444444444444444444444444444444444444444" as Address;
const hash = (value: number) =>
  ("0x" + value.toString(16).padStart(64, "0")) as Hex;
const gross = parseEther("4"),
  pot = parseEther("2"),
  payout = parseEther("1.4");

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "chickens-funding-test-"));
  const previous = {
    split: config.wallets.split,
    multisend: config.wallets.multisend,
  };
  config.wallets.split = split;
  config.wallets.multisend = multisend;
  const state = {
    nonce: 0,
    pending: 0,
    balance: parseEther("10"),
    available: gross,
    released: false,
    code: undefined as Hex | undefined,
    blockHash: hash(100),
    reads: [] as string[],
  };
  const transactions = new Map<
    Hex,
    {
      from: Address;
      to: Address | null;
      input: Hex;
      value: bigint;
      nonce: number;
      chainId: number;
    }
  >();
  const receipts = new Map<
    Hex,
    {
      from: Address;
      status: "success" | "reverted";
      transactionHash: Hex;
      blockNumber: bigint;
      blockHash: Hex;
      gasUsed: bigint;
      effectiveGasPrice: bigint;
    }
  >();
  const manifest = {
    version: 2,
    round: 1,
    endBlock: 100,
    creatorFeesWei: gross.toString(),
    potWei: pot.toString(),
    payouts: [
      { wallet: holder, category: "family", amountWei: payout.toString() },
    ],
    cook: { egg: parseEther("0.6").toString() },
    carry: [],
    hash: hash(777),
  } as unknown as PreparedRound["manifest"];
  const rpc = {
    getChainId: async () => config.chainId,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
      number: blockNumber ?? 500n,
      hash:
        blockNumber === 100n
          ? state.blockHash
          : hash(Number(blockNumber ?? 500n)),
      timestamp: 1000n,
      baseFeePerGas: 1n,
    }),
    getTransactionCount: async ({ blockTag }: { blockTag?: string }) =>
      blockTag === "pending" ? state.pending : state.nonce,
    getCode: async () => state.code,
    getBalance: async () => state.balance,
    call: async () => ({}),
    estimateGas: async () => 21000n,
    readContract: async ({ functionName }: { functionName: string }) => {
      state.reads.push(functionName);
      if (functionName === "released") return state.released;
      if (functionName === "grossFees") return gross;
      if (functionName === "balanceOf") return state.available;
      if (functionName === "paid") return false;
      if (functionName === "manifests") return manifest.hash;
      throw Error("Unexpected contract read");
    },
    getTransaction: async ({ hash: tx }: { hash: Hex }) => transactions.get(tx),
    getTransactionReceipt: async ({ hash: tx }: { hash: Hex }) =>
      receipts.get(tx),
    waitForTransactionReceipt: async ({ hash: tx }: { hash: Hex }) =>
      receipts.get(tx),
  } as unknown as OperatorTransactions["rpc"];
  const service = new OperatorTransactions({ rpc, directory });
  service.verifiedContract = async (name) =>
    name === "Split" ? split : multisend;
  service.prepared = {
    manifest,
    manifests: [manifest],
    tokens: [],
    proof: hash(999),
    endHash: hash(100),
  } as unknown as PreparedRound;
  const record = async (
    proposal: Proposal,
    status: "success" | "reverted" = "success",
    archived = false,
  ) => {
    const tx = hash(1000 + state.nonce);
    transactions.set(tx, {
      from: proposal.from,
      to: proposal.to ?? null,
      input: proposal.data,
      value: BigInt(proposal.value),
      nonce: state.nonce,
      chainId: config.chainId,
    });
    receipts.set(tx, {
      from: proposal.from,
      status,
      transactionHash: tx,
      blockNumber: 100n,
      blockHash: hash(100),
      gasUsed: 21000n,
      effectiveGasPrice: 1000002n,
    });
    const journal = { proposal, tx, confirmed: true };
    if (archived) {
      await mkdir(join(directory, "failed"), { recursive: true });
      await writeFile(
        join(directory, "failed", proposal.id + "-" + tx + ".json"),
        json(journal),
      );
    } else await service.save(journal);
    state.nonce++;
    state.pending = state.nonce;
    return tx;
  };
  return {
    directory,
    service,
    state,
    transactions,
    receipts,
    record,
    manifest,
    close: async () => {
      config.wallets.split = previous.split;
      config.wallets.multisend = previous.multisend;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("ten ETH in Feed cannot enlarge the fixed two ETH community allocation or skip the split", async () => {
  const f = await setup();
  try {
    const claim = (await f.service.nextSettlement()) as Proposal;
    assert.equal(claim.id, "round-1-claim");
    assert.equal(BigInt(claim.value), 0n);
    assert.deepEqual(
      decodeFunctionData({
        abi: parseAbi(["function claim(uint256 amount) returns (uint256)"]),
        data: claim.data,
      }).args,
      [gross],
    );
    await f.record(claim);
    const allocation = (await f.service.nextSettlement()) as Proposal;
    assert.equal(allocation.id, "round-1-split");
    assert.equal(BigInt(allocation.value), gross);
    assert.deepEqual(
      decodeFunctionData({ abi: splitAbi, data: allocation.data }).args,
      [1n],
    );
    await f.record(allocation);
    f.state.released = true;
    const batch = (await f.service.nextSettlement()) as Proposal;
    assert.equal(batch.id, "round-1-batch-0");
    assert.equal(BigInt(batch.value), payout);
    assert.equal(payout + BigInt(f.manifest.cook.egg), pot);
    const decoded = decodeFunctionData({ abi: multisendAbi, data: batch.data });
    assert.equal(decoded.functionName, "sendEth");
    assert.equal(decoded.args?.[0], 1n);
    assert.deepEqual(decoded.args?.[4], [payout]);
    await assert.rejects(
      f.service.proposal({ ...batch, value: parseEther("10") }),
      /fixed round allocation/,
    );
  } finally {
    await f.close();
  }
});

test("a manual claim cannot be masked by new escrow fees or a large wallet balance", async () => {
  const f = await setup();
  try {
    f.state.nonce = f.state.pending = 1;
    f.state.available = parseEther("100");
    f.state.balance = parseEther("100");
    await assert.rejects(
      f.service.nextSettlement(),
      /unsupported or unreconciled transaction/,
    );
    assert.deepEqual(
      f.state.reads,
      [],
      "reject before consulting unrelated available fees",
    );
    assert.equal(await f.service.read("round-1-claim"), undefined);
  } finally {
    await f.close();
  }
});

test("cook proposals cannot enlarge a chunk or switch the selected round when Feed has spare ETH", async () => {
  const f = await setup();
  try {
    const input = {
      id: "round-1-cook-egg-0-0-buy",
      label: "Cook",
      from: feed,
      to: holder,
      data: "0x" as Hex,
      value: parseEther("10"),
      proof: f.service.prepared!.proof,
    };
    await assert.rejects(
      f.service.proposal(input),
      /Cook exceeds its fixed round allocation/,
    );
    await assert.rejects(
      f.service.proposal({ ...input, id: "round-2-cook-egg-0-0-buy" }),
      /prepared round budget/,
    );
    assert.equal(await f.service.read(input.id), undefined);
  } finally {
    await f.close();
  }
});

test("a manual developer transfer after a recorded claim blocks settlement despite replacement funds", async () => {
  const f = await setup();
  try {
    const claim = (await f.service.nextSettlement()) as Proposal;
    await f.record(claim);
    f.state.nonce = f.state.pending = 2;
    f.state.balance = parseEther("100");
    f.state.available = parseEther("100");
    await assert.rejects(
      f.service.nextSettlement(),
      /unsupported or unreconciled transaction/,
    );
    assert.equal(await f.service.read("round-1-split"), undefined);
  } finally {
    await f.close();
  }
});

test("an older round cannot prepare spending while a later round has a recorded operation", async () => {
  const f = await setup();
  try {
    const claim = (await f.service.nextSettlement()) as Proposal;
    await f.service.save({ proposal: { ...claim, id: "round-2-claim" } });
    await assert.rejects(f.service.nextSettlement(), /latest recorded round/);
  } finally {
    await f.close();
  }
});

test("confirmed flags never replace matching canonical on-chain receipts", async () => {
  const f = await setup();
  try {
    const claim = (await f.service.nextSettlement()) as Proposal;
    const tx = await f.record(claim);
    f.transactions.get(tx)!.value = 1n;
    await assert.rejects(
      f.service.verifyFundingHistory(),
      /unsupported or unreconciled transaction/,
    );
    f.transactions.get(tx)!.value = 0n;
    f.state.blockHash = hash(101);
    await assert.rejects(
      f.service.verifyFundingHistory(),
      /receipt changed on-chain/,
    );
  } finally {
    await f.close();
  }
});

test("archived confirmed reverts retain their used nonce without reserving successful spending", async () => {
  const f = await setup();
  try {
    const claim = (await f.service.nextSettlement()) as Proposal;
    await f.record(claim, "reverted");
    await f.service.retryFailed(claim.id);
    assert.equal(await f.service.read(claim.id), undefined);
    assert.equal((await f.service.verifyFundingHistory()).verified, 1);
    assert.equal(await f.service.communityReserve(), 0n);
    const retry = (await f.service.nextSettlement()) as Proposal;
    assert.equal(retry.id, claim.id);
    assert.equal(retry.nonce, toHex(1));
    assert.equal(retry.data, claim.data);
  } finally {
    await f.close();
  }
});

test("delegated wallets and unconfirmed account activity are rejected", async () => {
  const f = await setup();
  try {
    f.state.code = "0xef01001111111111111111111111111111111111111111";
    await assert.rejects(
      f.service.verifyFundingHistory(),
      /undelegated externally owned/,
    );
    f.state.code = undefined;
    f.state.pending = 1;
    await assert.rejects(
      f.service.verifyFundingHistory(),
      /pending Feed transactions/,
    );
  } finally {
    await f.close();
  }
});

test("a Feed nonce change during proposal preparation cannot bypass history verification", async () => {
  const f = await setup();
  try {
    let changed = false;
    Object.assign(f.service.rpc, {
      getTransactionCount: async ({
        blockNumber,
        blockTag,
      }: {
        blockNumber?: bigint;
        blockTag?: string;
      }) => {
        if (blockNumber !== undefined) return 0;
        if (!blockTag) changed = true;
        return changed ? 1 : 0;
      },
    });
    await assert.rejects(
      f.service.nextSettlement(),
      /Feed history changed during preparation/,
    );
    assert.equal(await f.service.read("round-1-claim"), undefined);
  } finally {
    await f.close();
  }
});

test("failed preparation clears the previous round before validation", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.service.prepare(0), /positive round number/);
    assert.equal(f.service.prepared, undefined);
    await assert.rejects(
      f.service.nextSettlement(),
      /Prepare and verify the round first/,
    );
  } finally {
    await f.close();
  }
});

test("a partially filled earlier cook must resume and finish before the next round can claim fees", async () => {
  const f = await setup();
  const chunks = config.cook.chunks;
  config.cook.chunks = 1;
  try {
    const token = "0x5555555555555555555555555555555555555555" as Address;
    const curve = "0x6666666666666666666666666666666666666666" as Address;
    let paid = false;
    const swaps: unknown[] = [];
    const originalRead = f.service.rpc.readContract;
    Object.assign(f.service.rpc, {
      readContract: async (request: {
        functionName: string;
        args?: unknown[];
      }) => {
        if (request.functionName === "released")
          return request.args?.[0] === 1n && f.state.released;
        if (request.functionName === "paid")
          return request.args?.[0] === 1n && paid;
        if (request.functionName === "getLaunchedToken")
          return {
            token,
            curve,
            deployer: config.wallets.creator,
            creatorFeeRecipient: feed,
            pairToken: zeroAddress,
            graduationThreshold: 0n,
            poolFee: 0,
            tickSpacing: 200,
            creatorTaxBps: 100,
            buybackEnabled: false,
            phase: 0,
            sweptQuote: 0n,
            sweptTokens: 0n,
            sweptAt: 0n,
            exists: true,
          };
        if (request.functionName === "getLaunchFeePolicy")
          return { protocolFeeShareBps: 3000 };
        if (
          ["quoteFeeBalance", "creatorTaxBalance"].includes(
            request.functionName,
          )
        )
          return 0n;
        return originalRead(request as never);
      },
      getContractEvents: async () => swaps,
      simulateContract: async () => ({ result: 2n }),
    });
    f.service.report = async () => {};
    f.service.reportCook = async () => {};
    const priorPlan = f.service.prepared!;
    priorPlan.tokens = [
      {
        id: "egg",
        address: token,
        curve,
        pool: zeroAddress,
        role: "egg",
        isToken0: false,
        launchBlock: 90,
      },
    ];
    priorPlan.proof = keccak256(
      stringToHex(
        canonical({
          manifests: [financialManifest(f.manifest)],
          endHash: hash(100),
          wallets: config.wallets,
          chainId: config.chainId,
        }),
      ),
    );
    const recordBuy = async (
      proposal: Proposal,
      spent: bigint,
      received: bigint,
    ) => {
      const tx = await f.record(proposal);
      Object.assign(f.receipts.get(tx)!, {
        logs: [
          {
            address: token,
            topics: encodeEventTopics({
              abi: tokenAbi,
              eventName: "Transfer",
              args: { from: curve, to: feed },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [received]),
          },
        ],
      });
      swaps.push({
        eventName: "CurveBuy",
        blockNumber: 100n,
        logIndex: swaps.length,
        transactionHash: tx,
        args: {
          buyer: feed,
          recipient: feed,
          quoteIn: spent,
          tokensOut: received,
          fee: 0n,
          tax: 0n,
        },
      });
    };
    await f.record((await f.service.nextSettlement()) as Proposal);
    await f.record((await f.service.nextSettlement()) as Proposal);
    f.state.released = true;
    await f.record((await f.service.nextSettlement()) as Proposal);
    paid = true;
    const buy = (await f.service.nextSettlement()) as Proposal;
    assert.equal(buy.id, "round-1-cook-egg-0-0-buy");
    assert.equal(BigInt(buy.value), parseEther("0.6"));
    await recordBuy(buy, parseEther("0.4"), 4n);
    const burn = (await f.service.nextSettlement()) as Proposal;
    assert.equal(burn.id, "round-1-cook-egg-0-0-burn");
    await f.record(burn);

    const laterManifest = {
      ...f.manifest,
      round: 2,
      endBlock: 200,
      hash: hash(778),
    };
    const laterPlan = {
      ...priorPlan,
      manifest: laterManifest,
      manifests: [f.manifest, laterManifest],
      endHash: hash(200),
      proof: hash(2000),
    };
    f.service.prepared = laterPlan;
    await assert.rejects(
      f.service.nextSettlement(),
      /Complete and verify earlier cooks/,
    );
    assert.equal(await f.service.read("round-2-claim"), undefined);
    assert.equal(await f.service.read("round-1-cook-egg-0-1-buy"), undefined);

    f.service.prepared = priorPlan;
    const remainder = (await f.service.nextSettlement()) as Proposal;
    assert.equal(remainder.id, "round-1-cook-egg-0-1-buy");
    assert.equal(BigInt(remainder.value), parseEther("0.2"));
    await recordBuy(remainder, parseEther("0.2"), 2n);
    const finalBurn = (await f.service.nextSettlement()) as Proposal;
    assert.equal(finalBurn.id, "round-1-cook-egg-0-1-burn");
    await f.record(finalBurn);
    assert.equal(await f.service.nextSettlement(), null);
    assert.equal(await f.service.communityReserve(), 0n);

    f.service.prepared = laterPlan;
    const nextClaim = (await f.service.nextSettlement()) as Proposal;
    assert.equal(nextClaim.id, "round-2-claim");
    assert.equal(BigInt(nextClaim.value), 0n);
  } finally {
    config.cook.chunks = chunks;
    await f.close();
  }
});
