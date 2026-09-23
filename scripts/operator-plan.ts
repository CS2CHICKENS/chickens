import { type Address, type Hex, keccak256, stringToHex } from "viem";
import {
  config,
  excludedAddresses,
  json,
  type Carry,
} from "../packages/core/src/index";
import { weights, buildManifest } from "../packages/core/src/engine";
import { tokenSnapshot } from "../packages/core/src/chain";
import { settlementGasReference } from "../packages/core/src/gas";
import { reconstruct } from "./history";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return json(value);
}
export type Manifest = ReturnType<typeof buildManifest>;
export function financialManifest(value: Manifest) {
  return {
    version: value.version,
    round: value.round,
    endBlock: value.endBlock,
    potWei: value.potWei,
    creatorFeesWei: value.creatorFeesWei,
    payouts: value.payouts,
    carry: value.carry,
    hash: value.hash,
    cook: value.cook,
    minimumWei: value.minimumWei,
    estimatedGasWei: value.estimatedGasWei,
    gasPerRecipientWei: value.gasPerRecipientWei,
    gasFunding: value.gasFunding,
  };
}
export function compareManifest(expected: Manifest, published: Manifest) {
  if (
    canonical(financialManifest(expected)) !==
    canonical(financialManifest(published))
  )
    throw Error(
      "Published settlement differs from independent chain reconstruction",
    );
}
export async function prepareRound(roundId: number) {
  if (!Number.isSafeInteger(roundId) || roundId < 1)
    throw Error("Choose a positive round number");
  const history = await reconstruct();
  const { rpc, result, tokens, events } = history;
  let priorStreaks: Record<string, number> = {},
    carry: Carry[] = [];
  const manifests: Manifest[] = [];
  for (const round of result.rounds.filter((r) => r.id <= roundId)) {
    if (round.creatorFeeWei === undefined)
      throw Error("Exact gross creator fees are missing");
    const excluded = excludedAddresses(tokens);
    for (const wallet of new Set(
      events
        .filter((e) => e.block <= round.endBlock)
        .map((e) => e.wallet.toLowerCase()),
    )) {
      const code = await rpc.getCode({
        address: wallet as Address,
        blockNumber: BigInt(round.endBlock),
      });
      if (code && code !== "0x") excluded.add(wallet);
    }
    const prices: Record<string, bigint> = {},
      roundTokens = tokens.filter((t) => t.launchBlock <= round.endBlock);
    for (const token of roundTokens.filter((t) => t.family === round.winner))
      prices[token.id] = (
        await tokenSnapshot(rpc, token.address, BigInt(round.endBlock))
      ).priceWei;
    const w = weights(
      round,
      events.filter((e) => e.block <= round.endBlock),
      roundTokens,
      prices,
      excluded,
      priorStreaks,
    );
    priorStreaks = w.streaks;
    const reference = settlementGasReference(
      (await rpc.getBlock({ blockNumber: BigInt(round.endBlock) }))
        .baseFeePerGas,
    );
    const manifest = buildManifest(
      round,
      w,
      carry,
      reference,
      result.hatches.find((h) => h.round === round.id)?.remaining.length ?? 0,
      roundTokens,
    );
    const response = await fetch(
      "https://data.cs2chickens.fun/payouts/" + round.id + ".json",
      { redirect: "error", signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok)
      throw Error(
        "The verified round manifest must be published before settlement",
      );
    compareManifest(manifest, (await response.json()) as Manifest);
    carry = manifest.carry.map((c) => ({
      ...c,
      amountWei: BigInt(c.amountWei),
    }));
    manifests.push(manifest);
  }
  const manifest = manifests.at(-1);
  if (!manifest || manifest.round !== roundId)
    throw Error("Round has not ended");
  if (
    history.swaps.some(
      (s) =>
        s.block >= result.rounds[0].startBlock &&
        s.block <= manifest.endBlock &&
        !s.feeVerified,
    )
  )
    throw Error("Unverified fees prevent settlement");
  const endHash = (
    await rpc.getBlock({ blockNumber: BigInt(manifest.endBlock) })
  ).hash;
  return {
    rpc,
    tokens,
    manifest,
    manifests,
    endHash: endHash as Hex,
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
}
export type PreparedRound = Awaited<ReturnType<typeof prepareRound>>;
