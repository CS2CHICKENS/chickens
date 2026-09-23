import { keccak256, parseEther, stringToHex } from "viem";
import {
  config,
  json,
  roundStartBlock,
} from "../../../packages/core/src/index";
import type { Env } from "./index";
import type { ActiveRound } from "./publication";
import { meta, metaStatement, putMeta } from "./storage";

export function rulesFingerprint(legacy = false) {
  const round = { ...config.round };
  if (legacy) delete (round as Partial<typeof round>).preStartFeePolicy;
  return keccak256(
    stringToHex(
      json({
        round,
        testMode: config.testMode,
        fees: config.fees,
        split: config.split,
        payouts: config.payouts,
        families: config.families,
      }),
    ),
  );
}

export async function acceptRoundRules(
  env: Env,
  active: ActiveRound | null,
  hasRounds: boolean,
  cursor: number,
  indexStart: number,
) {
  const expected = rulesFingerprint();
  const saved = await meta(env.DB, "rulesFingerprint");
  if (!saved) {
    await putMeta(env.DB, "rulesFingerprint", expected);
    return { accepted: true, active };
  }
  if (saved === expected) return { accepted: true, active };
  // Only the waiting first round can adopt the explicitly reserved opening fees.
  if (
    saved !== rulesFingerprint(true) ||
    config.testMode ||
    config.round.startMode !== "first-family-trade" ||
    config.round.preStartFeePolicy !== "reserve-for-first-round" ||
    hasRounds ||
    (active && (active.id !== 1 || active.startTs !== 0)) ||
    indexStart !== roundStartBlock()
  )
    return { accepted: false, active };
  const history = await env.DB.prepare(
    "SELECT 1 FROM rounds UNION ALL SELECT 1 FROM manifests UNION ALL SELECT 1 FROM payouts UNION ALL SELECT 1 FROM carryover UNION ALL SELECT 1 FROM split_releases UNION ALL SELECT 1 FROM payout_receipts UNION ALL SELECT 1 FROM cooks LIMIT 1",
  ).first();
  const firstTrade = await env.DB.prepare(
    "SELECT id FROM swaps WHERE block<=? AND family IS NOT NULL AND kind='trade' AND volume<>'0' AND feeVerified=1 LIMIT 1",
  )
    .bind(cursor)
    .first();
  const verified = await meta(env.DB, "feesVerified");
  const generated = await meta(env.DB, "creatorFeesWei");
  if (
    history ||
    firstTrade ||
    (cursor >= indexStart &&
      (verified !== "true" || generated === undefined)) ||
    (generated !== undefined && !/^\d+$/.test(generated))
  )
    return { accepted: false, active };
  const reserved = BigInt(generated ?? "0");
  const next: ActiveRound = {
    id: 1,
    startBlock: indexStart,
    feeStartBlock: indexStart,
    startTs: 0,
    threshold: parseEther(String(config.round.firstThresholdEth)),
    tokens: {},
    families: {},
    creatorFeeWei: reserved,
    preStartCreatorFeeWei: reserved,
    growthSteps: 0,
  };
  await env.checkpoint?.();
  await env.DB.batch([
    metaStatement(env.DB, "active", json(next)),
    metaStatement(env.DB, "rulesFingerprint", expected),
  ]);
  return { accepted: true, active: next };
}
