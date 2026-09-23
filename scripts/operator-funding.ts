import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { client } from "../packages/core/src/chain";
import type { Proposal } from "./operator-transactions";

type FundingJournal = {
  proposal: Proposal;
  tx?: Hex;
  confirmed?: boolean;
};
type RecordedOperation = {
  journal: FundingJournal;
  reverted: boolean;
};
const operation =
  "(?:deploy-(?:Split|Multisend)|round-[1-9]\\d*-(?:claim|split|batch-\\d+|cook-[a-z0-9-]+|sweep-[a-z0-9-]+))";
const liveName = new RegExp("^(" + operation + ")\\.json$");
const failedName = new RegExp(
  "^(" + operation + ")-(0x[0-9a-fA-F]{64})\\.json$",
);
const reconciliation =
  "Feed history contains an unsupported or unreconciled transaction. Reconcile its confirmed receipts before continuing; wallet balance cannot replace a verified round allocation.";

async function journals(directory: string) {
  const records: RecordedOperation[] = [];
  for (const reverted of [false, true]) {
    const folder = reverted ? join(directory, "failed") : directory;
    const files = await readdir(folder, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      if (records.length >= 5000)
        throw Error(
          "Feed receipt verification exceeds the local work budget; reconcile the funding history before continuing",
        );
      const match = (reverted ? failedName : liveName).exec(file.name);
      if (!match) throw Error(reconciliation);
      const journal = JSON.parse(
        await readFile(join(folder, file.name), "utf8"),
      ) as FundingJournal;
      if (
        !journal.proposal ||
        journal.proposal.id !== match[1] ||
        !/^0x[0-9a-fA-F]{40}$/.test(journal.proposal.from) ||
        (journal.tx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(journal.tx)) ||
        (journal.confirmed && !journal.tx) ||
        (reverted && journal.tx?.toLowerCase() !== match[2].toLowerCase())
      )
        throw Error(reconciliation);
      records.push({ journal, reverted });
    }
  }
  return records;
}

export async function verifyFeedFundingHistory(options: {
  rpc: ReturnType<typeof client>;
  directory: string;
  feed: Address;
  chainId: number;
  confirmations: number;
  preparedRound?: number;
  matches: (
    proposal: Proposal,
    tx: {
      from: string;
      to: string | null;
      input: string;
      value: bigint;
      nonce: number;
      chainId?: number;
    },
  ) => boolean;
}) {
  const records = await journals(options.directory);
  const later = records.find(({ journal, reverted }) => {
    if (reverted) return false;
    const round = /^round-(\d+)-/.exec(journal.proposal.id);
    return (
      round &&
      (options.preparedRound === undefined ||
        Number(round[1]) > options.preparedRound)
    );
  });
  if (later)
    throw Error(
      "Prepare the latest recorded round before spending from Feed. An older or absent plan cannot protect later community allocations and carry.",
    );
  if ((await options.rpc.getChainId()) !== options.chainId)
    throw Error("RPC chain mismatch");
  const head = await options.rpc.getBlock();
  const [nonce, pending, code] = await Promise.all([
    options.rpc.getTransactionCount({
      address: options.feed,
      blockNumber: head.number,
    }),
    options.rpc.getTransactionCount({
      address: options.feed,
      blockTag: "pending",
    }),
    options.rpc.getCode({ address: options.feed, blockNumber: head.number }),
  ]);
  if (code && code !== "0x")
    throw Error(
      "Feed must be an undelegated externally owned wallet for verified settlement",
    );
  if (!Number.isSafeInteger(nonce) || nonce < 0 || pending !== nonce)
    throw Error(
      "Wait for pending Feed transactions and reconcile their receipts before continuing",
    );
  const known = records.filter(
    ({ journal }) =>
      journal.proposal.from.toLowerCase() === options.feed.toLowerCase() &&
      journal.tx,
  );
  if (known.length !== nonce) throw Error(reconciliation);
  const nonces = new Set<number>();
  const hashes = new Map<bigint, Hex>();
  for (const { journal, reverted } of known) {
    const [transaction, receipt] = await Promise.all([
      options.rpc.getTransaction({ hash: journal.tx! }),
      options.rpc.getTransactionReceipt({ hash: journal.tx! }),
    ]);
    if (
      !options.matches(journal.proposal, transaction) ||
      receipt.transactionHash.toLowerCase() !== journal.tx!.toLowerCase() ||
      receipt.from.toLowerCase() !== options.feed.toLowerCase() ||
      receipt.status !== (reverted ? "reverted" : "success") ||
      !Number.isSafeInteger(transaction.nonce) ||
      transaction.nonce < 0 ||
      transaction.nonce >= nonce ||
      nonces.has(transaction.nonce)
    )
      throw Error(reconciliation);
    if (head.number - receipt.blockNumber + 1n < BigInt(options.confirmations))
      throw Error(
        "Wait for confirmed Feed receipts before preparing another transaction",
      );
    let hash = hashes.get(receipt.blockNumber);
    if (!hash) {
      hash = (await options.rpc.getBlock({ blockNumber: receipt.blockNumber }))
        .hash;
      hashes.set(receipt.blockNumber, hash);
    }
    if (hash !== receipt.blockHash)
      throw Error(
        "Feed receipt changed on-chain; reconcile the funding history before continuing",
      );
    nonces.add(transaction.nonce);
  }
  // Both native escrow claim methods pay only msg.sender. Complete Feed nonce
  // coverage therefore rejects an unrecorded claim as well as a manual outflow.
  return { nonce, block: head.number, verified: known.length };
}
