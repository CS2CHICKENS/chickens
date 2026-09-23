import {
  readFile,
  readdir,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { config, json } from "../packages/core/src/index";
import {
  client,
  launchInfo,
  v4PoolId,
  readTokenTrades,
} from "../packages/core/src/chain";
import { nextCook, sweepAbi } from "./operator-cook";
import { multisendAbi, splitAbi } from "../packages/core/src/contracts";
import { payoutBatches } from "../packages/core/src/batches";
import { cookChunk } from "../packages/core/src/cook";
import {
  canonical,
  financialManifest,
  prepareRound,
  type PreparedRound,
} from "./operator-plan";
import { verifyFeedFundingHistory } from "./operator-funding";

export type Proposal = {
  id: string;
  label: string;
  from: Address;
  to?: Address;
  data: Hex;
  value: Hex;
  gas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  nonce: Hex;
  chainId: Hex;
  preparedBlock: number;
  proof: string;
  deploy?: "Split" | "Multisend";
};
type Journal = {
  proposal: Proposal;
  tx?: Hex;
  confirmed?: boolean;
  reported?: boolean;
};
type Artifact = {
  bytecode: { object: Hex };
  deployedBytecode: {
    object: Hex;
    immutableReferences: Record<string, { start: number; length: number }[]>;
  };
};
const feed = () => config.wallets.feed as Address;
const escrow = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function claim(uint256 amount) returns (uint256)",
]);
export function sameTransaction(
  proposal: Proposal,
  tx: {
    from: string;
    to: string | null;
    input: string;
    value: bigint;
    nonce: number;
    chainId?: number;
  },
) {
  return (
    tx.from.toLowerCase() === proposal.from.toLowerCase() &&
    (tx.to?.toLowerCase() ?? null) === (proposal.to?.toLowerCase() ?? null) &&
    tx.input.toLowerCase() === proposal.data.toLowerCase() &&
    tx.value === BigInt(proposal.value) &&
    tx.nonce === Number(BigInt(proposal.nonce)) &&
    (tx.chainId === undefined || tx.chainId === config.chainId)
  );
}
export function matchingRuntime(code: Hex | undefined, artifact: Artifact) {
  if (!code || code === "0x") return false;
  let actual = code.slice(2).toLowerCase(),
    expected = artifact.deployedBytecode.object
      .replace(/^0x/, "")
      .toLowerCase();
  if (actual.length !== expected.length) return false;
  for (const ref of Object.values(
    artifact.deployedBytecode.immutableReferences ?? {},
  ).flat()) {
    const start = ref.start * 2,
      end = start + ref.length * 2;
    if (start < 0 || end > expected.length) return false;
    actual =
      actual.slice(0, start) + "0".repeat(end - start) + actual.slice(end);
    expected =
      expected.slice(0, start) + "0".repeat(end - start) + expected.slice(end);
  }
  return actual === expected;
}
export class OperatorTransactions {
  readonly rpc: ReturnType<typeof client>;
  prepared?: PreparedRound;
  readonly directory: string;
  private persistDeployment: (key: string, address: Address) => Promise<void>;
  constructor(
    options: {
      rpc?: ReturnType<typeof client>;
      directory?: string;
      persistDeployment?: (key: string, address: Address) => Promise<void>;
    } = {},
  ) {
    this.rpc = options.rpc ?? client(process.env.BACKUP_RPC_URL);
    this.directory = options.directory ?? "private/operator-runs";
    this.persistDeployment =
      options.persistDeployment ??
      (async (key, address) => {
        const disk = JSON.parse(await readFile("config/config.json", "utf8"));
        disk.wallets[key] = address;
        const temporary = "config/config.json.tmp",
          file = await open(temporary, "w");
        try {
          await file.writeFile(JSON.stringify(disk, null, 2) + "\n");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, "config/config.json");
      });
  }
  private artifacts = new Map<string, Artifact>();
  async artifact(name: "Split" | "Multisend") {
    let value = this.artifacts.get(name);
    if (!value) {
      value = JSON.parse(
        await readFile(
          join("contracts", "out", name + ".sol", name + ".json"),
          "utf8",
        ),
      ) as Artifact;
      this.artifacts.set(name, value);
    }
    return value;
  }
  path(id: string) {
    if (
      !/^(deploy-(Split|Multisend)|round-[1-9]\d*-(claim|split|batch-\d+|cook-[a-z0-9-]+|sweep-[a-z0-9-]+))$/.test(
        id,
      )
    )
      throw Error("Invalid operation");
    return join(this.directory, id + ".json");
  }
  async read(id: string): Promise<Journal | undefined> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async save(journal: Journal, exclusive = false) {
    await mkdir(this.directory, { recursive: true });
    const path = this.path(journal.proposal.id),
      target = exclusive ? path : path + ".tmp";
    const handle = await open(target, exclusive ? "wx" : "w");
    try {
      await handle.writeFile(json(journal));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!exclusive) await rename(target, path);
  }
  async prepare(round: number) {
    this.prepared = undefined;
    const prepared = await prepareRound(round);
    this.prepared = prepared;
    await mkdir(this.directory, { recursive: true });
    return {
      round,
      manifest: prepared.manifest,
      proof: prepared.proof,
      endHash: prepared.endHash,
      batches: payoutBatches(prepared.manifest.payouts).length,
    };
  }
  async verifiedContract(name: "Split" | "Multisend") {
    const address = config.wallets[
      name === "Split" ? "split" : "multisend"
    ] as Address | null;
    if (!address)
      throw Error("Deploy and verify both settlement contracts first");
    if (
      !matchingRuntime(
        await this.rpc.getCode({ address }),
        await this.artifact(name),
      )
    )
      throw Error("Deployed contract does not match the local reviewed build");
    const actualFeed = await this.rpc.readContract({
      address,
      abi: multisendAbi,
      functionName: "feed",
    });
    if (actualFeed.toLowerCase() !== feed().toLowerCase())
      throw Error("Contract Feed recipient mismatch");
    if (name === "Split") {
      const dev = await this.rpc.readContract({
        address,
        abi: splitAbi,
        functionName: "dev",
      });
      if (dev.toLowerCase() !== config.wallets.dev?.toLowerCase())
        throw Error("Contract developer recipient mismatch");
    }
    return address;
  }
  async proposal(
    input: Pick<
      Proposal,
      "id" | "label" | "from" | "to" | "data" | "proof" | "deploy"
    > & { value: bigint; gasCap?: bigint },
  ): Promise<Proposal> {
    this.assertRoundBudget(input);
    const existing = await this.read(input.id);
    if (existing) {
      if (existing.tx)
        throw Error(
          "An existing transaction must be reconciled before continuing",
        );
      throw Error(
        "A previous wallet request is unresolved. Reconcile its transaction hash or explicitly cancel it after rejecting it in Rabby.",
      );
    }
    for (const file of await readdir(this.directory).catch(
      () => [] as string[],
    )) {
      if (!file.endsWith(".json")) continue;
      const pending = await this.read(file.slice(0, -5));
      if (pending && !pending.confirmed)
        throw Error(
          "Resolve the pending operation before preparing another: " +
            pending.proposal.id,
        );
    }
    const funding = await this.verifyFundingHistory();
    if ((await this.rpc.getChainId()) !== config.chainId)
      throw Error("RPC chain mismatch");
    const [latest, pending, block] = await Promise.all([
      this.rpc.getTransactionCount({ address: input.from }),
      this.rpc.getTransactionCount({
        address: input.from,
        blockTag: "pending",
      }),
      this.rpc.getBlock(),
    ]);
    if (latest !== pending)
      throw Error("Wait for pending transactions in the signing account");
    if (
      input.from.toLowerCase() === feed().toLowerCase() &&
      latest !== funding.nonce
    )
      throw Error(
        "Feed history changed during preparation; reconcile its receipts and prepare again",
      );
    const request = {
      account: input.from,
      to: input.to,
      data: input.data,
      value: input.value,
    };
    await this.rpc.call(request);
    const gas = ((await this.rpc.estimateGas(request)) * 120n) / 100n;
    if (block.baseFeePerGas === null)
      throw Error("A current base fee is required");
    const priority = 1000000n,
      maximum = block.baseFeePerGas * 2n + priority;
    if (input.gasCap !== undefined && gas * maximum > input.gasCap)
      throw Error(
        "Gas exceeds the remaining round payout budget; retry when fees are lower",
      );
    const reserve =
      input.from.toLowerCase() === feed().toLowerCase()
        ? await this.communityReserve()
        : 0n;
    const required =
      (reserve > input.value ? reserve : input.value) + gas * maximum;
    if ((await this.rpc.getBalance({ address: input.from })) < required)
      throw Error(
        "Top up ETH for gas separately: outstanding community allocations and carry must remain fully funded",
      );
    const proposal: Proposal = {
      id: input.id,
      label: input.label,
      from: input.from,
      to: input.to,
      data: input.data,
      value: toHex(input.value),
      gas: toHex(gas),
      maxFeePerGas: toHex(maximum),
      maxPriorityFeePerGas: toHex(priority),
      nonce: toHex(pending),
      chainId: toHex(config.chainId),
      preparedBlock: Number(block.number),
      proof: input.proof,
      deploy: input.deploy,
    };
    await this.save({ proposal }, true);
    return proposal;
  }
  private assertRoundBudget(input: {
    id: string;
    from: Address;
    to?: Address;
    data: Hex;
    value: bigint;
    proof: string;
  }) {
    const match = /^round-(\d+)-(.+)$/.exec(input.id);
    if (!match) return;
    const plan = this.prepared;
    if (
      !plan ||
      Number(match[1]) !== plan.manifest.round ||
      input.proof !== plan.proof
    )
      throw Error("Transaction does not belong to the prepared round budget");
    const manifest = plan.manifest,
      action = match[2],
      gross = BigInt(manifest.creatorFeesWei ?? "0");
    if (manifest.creatorFeesWei === null)
      throw Error("Gross fees are unverified");
    if (
      input.from.toLowerCase() !== feed().toLowerCase() &&
      (!action.startsWith("sweep-") ||
        input.from.toLowerCase() !== config.wallets.creator?.toLowerCase())
    )
      throw Error(
        "Transaction signer does not match the prepared round workflow",
      );
    let amount: bigint | undefined,
      data: Hex | undefined,
      destination: string | null | undefined;
    if (action === "claim") {
      amount = 0n;
      destination = config.protocol.feeEscrow;
      data = encodeFunctionData({
        abi: escrow,
        functionName: "claim",
        args: [gross],
      });
    } else if (action === "split") {
      amount = gross;
      destination = config.wallets.split;
      data = encodeFunctionData({
        abi: splitAbi,
        functionName: "releaseRound",
        args: [BigInt(manifest.round)],
      });
    } else if (action.startsWith("batch-")) {
      const batch = payoutBatches(manifest.payouts).find(
        (entry) => entry.index === Number(action.slice(6)),
      );
      if (!batch)
        throw Error("Unknown holder batch in the prepared round budget");
      amount = batch.value;
      destination = config.wallets.multisend;
      data = encodeFunctionData({
        abi: multisendAbi,
        functionName: "sendEth",
        args: [
          BigInt(manifest.round),
          manifest.hash,
          BigInt(batch.index),
          batch.to,
          batch.amounts,
        ],
      });
    } else if (action.startsWith("sweep-") || action.endsWith("-burn")) {
      amount = 0n;
    } else {
      const cook = /^cook-(.+)-(\d+)-(\d+)-buy$/.exec(action);
      if (!cook || manifest.cook[cook[1]] === undefined)
        throw Error("Unknown cook in the prepared round budget");
      const index = Number(cook[2]);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= config.cook.chunks ||
        input.value <= 0n ||
        input.value >
          cookChunk(BigInt(manifest.cook[cook[1]]), index, config.cook.chunks)
      )
        throw Error("Cook exceeds its fixed round allocation");
    }
    if (
      (amount !== undefined && input.value !== amount) ||
      (data !== undefined && input.data.toLowerCase() !== data.toLowerCase()) ||
      (destination !== undefined &&
        input.to?.toLowerCase() !== destination?.toLowerCase())
    )
      throw Error(
        "Transaction exceeds or differs from the fixed round allocation",
      );
  }
  async communityReserve() {
    if (!this.prepared) return 0n;
    let reserve = 0n;
    const split = await this.verifiedContract("Split"),
      multisend = await this.verifiedContract("Multisend");
    for (const m of this.prepared.manifests) {
      const prefix = "round-" + m.round,
        round = BigInt(m.round);
      if (m.creatorFeesWei === null) throw Error("Unverified gross fees");
      const gross = BigInt(m.creatorFeesWei);
      const released = await this.rpc.readContract({
        address: split,
        abi: splitAbi,
        functionName: "released",
        args: [round],
      });
      if (released) {
        if (
          (await this.rpc.readContract({
            address: split,
            abi: splitAbi,
            functionName: "grossFees",
            args: [round],
          })) !== gross
        )
          throw Error("Split allocation mismatch");
        reserve += BigInt(m.potWei);
      } else {
        const claim = await this.read(prefix + "-claim");
        if (claim?.tx) {
          await this.confirm(prefix + "-claim", claim.tx);
          reserve += gross;
        }
      }
      for (const batch of payoutBatches(m.payouts)) {
        if (
          await this.rpc.readContract({
            address: multisend,
            abi: multisendAbi,
            functionName: "paid",
            args: [round, BigInt(batch.index)],
          })
        ) {
          if (
            (await this.rpc.readContract({
              address: multisend,
              abi: multisendAbi,
              functionName: "manifests",
              args: [round],
            })) !== m.hash
          )
            throw Error("Paid manifest mismatch");
          reserve -= batch.value;
        }
      }
      for (const file of await readdir(this.directory).catch(
        () => [] as string[],
      )) {
        if (!file.startsWith(prefix + "-cook-") || !file.endsWith("-buy.json"))
          continue;
        const id = file.slice(0, -5),
          journal = await this.read(id);
        if (!journal?.tx) continue;
        await this.confirm(id, journal.tx);
        const receipt = await this.rpc.getTransactionReceipt({
          hash: journal.tx,
        });
        const tokenId = id
          .slice((prefix + "-cook-").length)
          .replace(/-\d+-\d+-buy$/, "");
        const token = this.prepared.tokens.find((t) => t.id === tokenId);
        if (!token) throw Error("Unknown cooked token");
        const swaps = (
          await readTokenTrades(
            this.rpc,
            [token],
            receipt.blockNumber,
            receipt.blockNumber,
          )
        ).filter(
          (s) =>
            s.tx.toLowerCase() === journal.tx!.toLowerCase() &&
            s.side === "buy" &&
            s.kind !== "fee-credit" &&
            s.wallet.toLowerCase() === feed().toLowerCase() &&
            s.feeVerified,
        );
        const spent = swaps.reduce((sum, s) => sum + s.volume, 0n);
        if (spent <= 0n || spent > BigInt(journal.proposal.value))
          throw Error("Cook spend cannot be verified");
        reserve -= spent;
      }
    }
    if (reserve < 0n)
      throw Error("Settlement journal exceeds verified funding");
    return reserve;
  }
  async verifyFundingHistory() {
    return verifyFeedFundingHistory({
      rpc: this.rpc,
      directory: this.directory,
      feed: feed(),
      chainId: config.chainId,
      confirmations: config.confirmations,
      preparedRound: this.prepared?.manifest.round,
      matches: sameTransaction,
    });
  }
  async nextDeployment() {
    for (const name of ["Split", "Multisend"] as const) {
      const key = name === "Split" ? "split" : "multisend";
      if (config.wallets[key]) {
        await this.verifiedContract(name);
        continue;
      }
      const artifact = await this.artifact(name);
      const data =
        name === "Split"
          ? encodeDeployData({
              abi: splitAbi,
              bytecode: artifact.bytecode.object,
              args: [config.wallets.dev as Address, feed()],
            })
          : encodeDeployData({
              abi: multisendAbi,
              bytecode: artifact.bytecode.object,
              args: [feed()],
            });
      return this.proposal({
        id: "deploy-" + name,
        label: "Deploy " + name,
        from: feed(),
        data,
        value: 0n,
        proof: keccak256(data),
        deploy: name,
      });
    }
    return null;
  }
  async nextSettlement() {
    const plan = this.prepared;
    if (!plan) throw Error("Prepare and verify the round first");
    await this.verifyFundingHistory();
    const m = plan.manifest,
      round = BigInt(m.round),
      prefix = "round-" + round;
    if (
      (await this.rpc.getBlock({ blockNumber: BigInt(m.endBlock) })).hash !==
      plan.endHash
    )
      throw Error("Round end block changed; rebuild the plan");
    const split = await this.verifiedContract("Split"),
      multisend = await this.verifiedContract("Multisend");
    for (const earlier of plan.manifests.filter(
      (entry) => entry.round < m.round,
    )) {
      if (
        BigInt(earlier.creatorFeesWei ?? "0") > 0n &&
        !(await this.rpc.readContract({
          address: split,
          abi: splitAbi,
          functionName: "released",
          args: [BigInt(earlier.round)],
        }))
      )
        throw Error("Settle earlier rounds first");
      for (const batch of payoutBatches(earlier.payouts))
        if (
          !(await this.rpc.readContract({
            address: multisend,
            abi: multisendAbi,
            functionName: "paid",
            args: [BigInt(earlier.round), BigInt(batch.index)],
          }))
        )
          throw Error("Complete earlier holder distributions first");
      await this.verifyEarlierCooks(plan, earlier);
    }
    if (m.creatorFeesWei === null) throw Error("Gross fees are unverified");
    const gross = BigInt(m.creatorFeesWei);
    if (
      gross > 0n &&
      !(await this.rpc.readContract({
        address: split,
        abi: splitAbi,
        functionName: "released",
        args: [round],
      }))
    ) {
      const claimed = await this.read(prefix + "-claim");
      if (claimed && claimed.proposal.proof !== plan.proof)
        throw Error("Saved claim belongs to a different verified plan");
      if (!claimed?.confirmed) {
        const available = await this.rpc.readContract({
          address: config.protocol.feeEscrow as Address,
          abi: escrow,
          functionName: "balanceOf",
          args: [feed()],
        });
        if (available < gross) {
          for (const token of plan.tokens) {
            const info = await launchInfo(this.rpc, token.address);
            const address =
              info.phase === 0 ? info.curve : (config.protocol.hook as Address);
            if (info.phase === 1) continue;
            const pool = v4PoolId(
              token.address,
              info.pairToken,
              info.poolFee,
              info.tickSpacing,
            );
            const amount =
              info.phase === 0
                ? (await this.rpc.readContract({
                    address,
                    abi: sweepAbi,
                    functionName: "quoteFeeBalance",
                  })) +
                  (await this.rpc.readContract({
                    address,
                    abi: sweepAbi,
                    functionName: "creatorTaxBalance",
                  }))
                : (await this.rpc.readContract({
                    address,
                    abi: sweepAbi,
                    functionName: "pendingFees",
                    args: [pool, "0x0000000000000000000000000000000000000000"],
                  })) +
                  (await this.rpc.readContract({
                    address,
                    abi: sweepAbi,
                    functionName: "pendingCreatorTax",
                    args: [pool, "0x0000000000000000000000000000000000000000"],
                  }));
            if (!amount) continue;
            const id = prefix + "-sweep-" + token.id;
            const previous = await this.read(id);
            if (previous?.confirmed) continue;
            const data =
              info.phase === 0
                ? encodeFunctionData({
                    abi: sweepAbi,
                    functionName: "sweepFees",
                    args: [0n],
                  })
                : encodeFunctionData({
                    abi: sweepAbi,
                    functionName: "sweepPoolFees",
                    args: [pool, 0n, 0n],
                  });
            let signer: Address | undefined;
            for (const account of [feed(), config.wallets.creator as Address]) {
              try {
                await this.rpc.call({ account, to: address, data });
                signer = account;
                break;
              } catch {}
            }
            if (!signer) continue;
            return this.proposal({
              id,
              label: "Sweep " + token.id.toUpperCase() + " fees",
              from: signer,
              to: address,
              data,
              value: 0n,
              proof: plan.proof,
            });
          }
          throw Error(
            "This round's gross fees are not available in escrow. Converted-token fees can require the Pons sweep operator; manually claimed fees require receipt reconciliation.",
          );
        }
        return this.proposal({
          id: prefix + "-claim",
          label: "Claim this round's creator fees",
          from: feed(),
          to: config.protocol.feeEscrow as Address,
          data: encodeFunctionData({
            abi: escrow,
            functionName: "claim",
            args: [gross],
          }),
          value: 0n,
          proof: plan.proof,
        });
      }
      await this.confirm(prefix + "-claim", claimed.tx!);
      return this.proposal({
        id: prefix + "-split",
        label: "Allocate 50% developer / 50% community",
        from: feed(),
        to: split,
        data: encodeFunctionData({
          abi: splitAbi,
          functionName: "releaseRound",
          args: [round],
        }),
        value: gross,
        proof: plan.proof,
      });
    }
    if (
      gross > 0n &&
      (await this.rpc.readContract({
        address: split,
        abi: splitAbi,
        functionName: "grossFees",
        args: [round],
      })) !== gross
    )
      throw Error(
        "On-chain split does not match this round's verified gross fees",
      );
    let spentGas = 0n;
    for (const batch of payoutBatches(m.payouts)) {
      const id = prefix + "-batch-" + batch.index,
        saved = await this.read(id);
      if (saved && saved.proposal.proof !== plan.proof)
        throw Error("Saved payment belongs to a different verified plan");
      if (saved?.tx) {
        const receipt = await this.confirm(id, saved.tx);
        spentGas += BigInt(receipt.gasWei);
        await this.report(id, m.round, saved.tx);
        continue;
      }
      if (
        await this.rpc.readContract({
          address: multisend,
          abi: multisendAbi,
          functionName: "paid",
          args: [round, BigInt(batch.index)],
        })
      )
        throw Error(
          "Batch already paid on-chain; reconcile its receipt without sending again",
        );
      return this.proposal({
        id,
        label:
          "Pay holder batch " +
          (batch.index + 1) +
          " · " +
          batch.to.length +
          " recipients",
        from: feed(),
        to: multisend,
        data: encodeFunctionData({
          abi: multisendAbi,
          functionName: "sendEth",
          args: [round, m.hash, BigInt(batch.index), batch.to, batch.amounts],
        }),
        value: batch.value,
        proof: plan.proof,
        gasCap: (BigInt(m.potWei) * 3n) / 100n - spentGas,
      });
    }
    return nextCook(this);
  }
  private async verifyEarlierCooks(
    plan: PreparedRound,
    manifest: PreparedRound["manifest"],
  ) {
    const pending = () =>
      Error(
        "Complete and verify earlier cooks before starting another round allocation",
      );
    if (!Object.values(manifest.cook).some((value) => BigInt(value) > 0n))
      return;
    for (const [token, value] of Object.entries(manifest.cook))
      for (let index = 0; index < config.cook.chunks; index++) {
        if (cookChunk(BigInt(value), index, config.cook.chunks) === 0n)
          continue;
        const prefix = `round-${manifest.round}-cook-${token}-${index}-0`;
        const [buy, burn] = await Promise.all([
          this.read(prefix + "-buy"),
          this.read(prefix + "-burn"),
        ]);
        if (!buy?.tx || !burn?.tx) throw pending();
      }
    const manifests = plan.manifests.filter(
      (entry) => entry.round <= manifest.round,
    );
    const endHash = (
      await this.rpc.getBlock({ blockNumber: BigInt(manifest.endBlock) })
    ).hash;
    const previous = Object.create(this) as OperatorTransactions;
    previous.prepared = {
      ...plan,
      manifest,
      manifests,
      endHash,
      proof: keccak256(
        stringToHex(
          canonical({
            manifests: manifests.map(financialManifest),
            endHash,
            wallets: config.wallets,
            chainId: config.chainId,
          }),
        ),
      ),
    };
    previous.proposal = async () => {
      throw pending();
    };
    if ((await nextCook(previous)) !== null) throw pending();
  }
  async confirm(id: string, tx: Hex) {
    const journal = await this.read(id);
    if (!journal) throw Error("No prepared operation matches this receipt");
    if (journal.tx && journal.tx.toLowerCase() !== tx.toLowerCase())
      throw Error("Operation already references another transaction");
    const transaction = await this.rpc.getTransaction({ hash: tx });
    if (!sameTransaction(journal.proposal, transaction))
      throw Error("Transaction differs from the prepared operation");
    journal.tx = tx;
    await this.save(journal);
    const receipt = await this.rpc.waitForTransactionReceipt({
      hash: tx,
      confirmations: config.confirmations,
      timeout: 60000,
    });
    if (receipt.status !== "success" || receipt.transactionHash !== tx)
      throw Error(
        "Transaction failed or was replaced; reconciliation required",
      );
    if (journal.proposal.deploy) {
      const name = journal.proposal.deploy;
      const address = getContractAddress({
        from: journal.proposal.from,
        nonce: BigInt(journal.proposal.nonce),
      });
      if (
        receipt.contractAddress?.toLowerCase() !== address.toLowerCase() ||
        !matchingRuntime(
          await this.rpc.getCode({ address }),
          await this.artifact(name),
        )
      )
        throw Error("Deployment bytecode mismatch");
      const key = name === "Split" ? "split" : "multisend";
      const previous = config.wallets[key];
      if (previous && previous.toLowerCase() !== address.toLowerCase())
        throw Error("Another deployment is already configured");
      config.wallets[key] = address;
      try {
        await this.verifiedContract(name);
      } catch (error) {
        config.wallets[key] = previous;
        throw error;
      }
      try {
        await this.persistDeployment(key, address);
      } catch (error) {
        config.wallets[key] = previous;
        throw error;
      }
    }
    journal.confirmed = true;
    await this.save(journal);
    return {
      tx,
      confirmed: true,
      gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    };
  }
  async cancel(id: string) {
    const journal = await this.read(id);
    if (!journal || journal.tx)
      throw Error("Only an unsubmitted wallet request can be cancelled");
    const pending = await this.rpc.getTransactionCount({
      address: journal.proposal.from,
      blockTag: "pending",
    });
    if (pending !== Number(BigInt(journal.proposal.nonce)))
      throw Error("Nonce changed; reconcile the transaction first");
    await unlink(this.path(id));
  }
  async retryFailed(id: string) {
    const journal = await this.read(id);
    if (!journal?.tx)
      throw Error("Reconcile the transaction hash before retrying");
    const transaction = await this.rpc.getTransaction({ hash: journal.tx });
    if (!sameTransaction(journal.proposal, transaction))
      throw Error("Transaction differs from the prepared operation");
    const receipt = await this.rpc.waitForTransactionReceipt({
      hash: journal.tx,
      confirmations: config.confirmations,
      timeout: 60000,
    });
    if (receipt.status !== "reverted" || receipt.transactionHash !== journal.tx)
      throw Error("Only a confirmed reverted transaction can be retried");
    await mkdir(join(this.directory, "failed"), { recursive: true });
    await rename(
      this.path(id),
      join(this.directory, "failed", id + "-" + journal.tx + ".json"),
    );
  }
  async report(id: string, round: number, tx: Hex) {
    return this.publishReceipt(id, "payouts", { action: "payouts", round, tx });
  }
  async reportCook(
    id: string,
    round: number,
    token: string,
    buyTx: Hex,
    burnTx: Hex,
  ) {
    return this.publishReceipt(id, "cooks", {
      action: "cooks",
      round,
      token,
      buyTx,
      burnTx,
    });
  }
  private async publishReceipt(id: string, path: string, body: unknown) {
    const journal = await this.read(id);
    if (journal?.reported) return;
    if (!process.env.ADMIN_URL || !process.env.ADMIN_SECRET)
      throw Error(
        "Payment confirmed. Configure the local admin reporting environment and resume; no second payment will be sent.",
      );
    const url = new URL(process.env.ADMIN_URL);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw Error("Admin URL must be a plain HTTPS origin");
    const response = await fetch(url.origin + "/admin/" + path, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-admin-secret": process.env.ADMIN_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw Error(
        "Payment confirmed but publication failed. Resume to report the saved receipt.",
      );
    journal!.reported = true;
    await this.save(journal!);
  }
}
