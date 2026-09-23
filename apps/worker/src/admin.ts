import { type Address, type Hex, parseAbi, decodeEventLog } from "viem";
import { z } from "zod";
import {
  config,
  productionReady,
  roundsReady,
  json,
} from "../../../packages/core/src/index";
import { client } from "../../../packages/core/src/chain";
import { payoutBatches } from "../../../packages/core/src/batches";
import { multisendAbi } from "../../../packages/core/src/contracts";
import { meta, putMeta, metadata, metaStatement } from "./storage";
import { emptyState } from "../../../packages/core/src/state";
import type { Env } from "./index";
import { reportCook } from "./cook-receipts";
import { loadManifest } from "./manifests";
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({
    action: z.literal("reindex"),
    block: z.number().int().min(config.factoryStartBlock),
  }),
  z.object({
    action: z.literal("payouts"),
    round: z.number().int().positive(),
    tx: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((value) => value.toLowerCase()),
  }),
  z.object({
    action: z.literal("cooks"),
    round: z.number().int().positive(),
    token: z.string().regex(/^[a-z0-9-]+$/),
    buyTx: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((value) => value.toLowerCase()),
    burnTx: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((value) => value.toLowerCase()),
  }),
]);
async function authorize(request: Request, secret?: string) {
  if (!secret) return false;
  const header = request.headers.get("x-admin-secret") || "";
  const a = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ),
    b = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(header)),
    );
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export async function handleAdmin(request: Request, env: Env) {
  if (!new URL(request.url).pathname.startsWith("/admin/"))
    return new Response("Not found", { status: 404 });
  if (!(await authorize(request, env.ADMIN_SECRET)))
    return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (Number(request.headers.get("content-length") || 0) > 8192)
    return new Response("Too large", { status: 413 });
  let data: z.infer<typeof requestSchema>;
  try {
    const body = await request.text();
    if (body.length > 8192) return new Response("Too large", { status: 413 });
    data = requestSchema.parse(JSON.parse(body));
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
  if (data.action === "pause" || data.action === "resume") {
    await putMeta(env.DB, "paused", String(data.action === "pause"));
    return Response.json({ ok: true });
  }
  if (data.action === "reindex") {
    if ((await meta(env.DB, "paused")) !== "true")
      return new Response("Pause before re-index", { status: 409 });
    const paid = await env.DB.prepare(
      "SELECT tx FROM payout_receipts UNION SELECT burnTx AS tx FROM cook_receipts LIMIT 1",
    ).first();
    if (paid)
      return new Response("Distributed ledger requires manual reconciliation", {
        status: 409,
      });
    const now = Math.floor(Date.now() / 1000),
      lease = String(now + 600);
    const acquired = await env.DB.prepare(
      "INSERT INTO meta(key,value) VALUES('lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(meta.value AS INTEGER) < ? RETURNING value",
    )
      .bind(lease, now)
      .first();
    if (!acquired)
      return new Response(
        "Indexer is still draining; retry when its lease ends",
        { status: 409 },
      );
    try {
      const from = Number(
        (await meta(env.DB, "indexStart")) ?? config.factoryStartBlock,
      );
      let afterRound = 0,
        afterWallet = "";
      while (true) {
        const rows = (
          await env.DB.prepare(
            "SELECT round FROM manifests WHERE round>? ORDER BY round LIMIT 500",
          )
            .bind(afterRound)
            .all<{ round: number }>()
        ).results;
        if (!rows.length) break;
        await env.DATA.delete(
          rows.map((row) => "payouts/" + row.round + ".json"),
        );
        afterRound = rows.at(-1)!.round;
      }
      while (true) {
        const rows = (
          await env.DB.prepare(
            "SELECT DISTINCT wallet FROM current_balances WHERE wallet>? ORDER BY wallet LIMIT 500",
          )
            .bind(afterWallet)
            .all<{ wallet: string }>()
        ).results;
        if (!rows.length) break;
        await env.DATA.delete(
          rows.map((row) => "wallets/" + row.wallet + ".json"),
        );
        afterWallet = rows.at(-1)!.wallet;
      }
      const lastRound =
        (
          await env.DB.prepare("SELECT MAX(id) AS id FROM rounds").first<{
            id: number | null;
          }>()
        )?.id ?? 0;
      for (let page = 0; page < Math.ceil(lastRound / 100); page += 500)
        await env.DATA.delete(
          Array.from(
            { length: Math.min(500, Math.ceil(lastRound / 100) - page) },
            (_, index) => `history/rounds/${page + index}.json`,
          ),
        );
      await env.DATA.put("state.json", json(emptyState), metadata);
      // Opening balances and fee-rounding state require a complete replay from the verified deployment boundary.
      await env.DB.batch([
        ...[
          "swaps",
          "balance_events",
          "blocks",
          "launches",
          "rounds",
          "hatches",
          "payouts",
          "carryover",
          "manifests",
          "swaps_agg",
          "split_releases",
          "current_balances",
          "wallet_dirty",
          "settlement_jobs",
          "round_weights",
          "round_balances",
          "planned_carry",
          "data_publications",
          "settlement_pages",
          "fee_collection_events",
          "work_jobs",
          "publication_changes",
          "publication_round_totals",
          "history_dirty",
          "history_wins",
          "wallet_history_dirty",
          "wallet_metric_jobs",
          "wallet_reward_changes",
          "wallet_reward_totals",
          "feed_source_changes",
          "feed_source_totals",
        ].map((table) => env.DB.prepare("DELETE FROM " + table)),
        env.DB.prepare("DELETE FROM tokens WHERE role='variant'"),
        env.DB.prepare(
          "UPDATE publication_totals SET owedWei='0',devWei='0' WHERE id=1",
        ),
        env.DB.prepare(
          "DELETE FROM meta WHERE key IN ('active','creatorFeesWei','feesVerified','lastSuccess','lastPublished','stagedRange','walletRefreshCursor','rulesFingerprint','feeCollection','feeCollectionStaged')",
        ),
        metaStatement(env.DB, "cursor", String(from - 1)),
      ]);
      return Response.json({
        ok: true,
        replayFrom: from,
        requestedBlock: data.block,
        paused: true,
      });
    } finally {
      await env.DB.prepare("DELETE FROM meta WHERE key='lease' AND value=?")
        .bind(lease)
        .run();
    }
  }
  if (!productionReady())
    return new Response("Settlement configuration incomplete", { status: 409 });
  let lease = String(Math.floor(Date.now() / 1000) + 600);
  const acquired = await env.DB.prepare(
    "INSERT INTO meta(key,value) VALUES('lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(meta.value AS INTEGER) < ? RETURNING value",
  )
    .bind(lease, Math.floor(Date.now() / 1000))
    .first();
  if (!acquired)
    return new Response("Ledger update in progress; retry this receipt", {
      status: 409,
    });
  const checkpoint = async () => {
    const now = Math.floor(Date.now() / 1000),
      next = String(now + 600);
    const renewed = await env.DB.prepare(
      "UPDATE meta SET value=? WHERE key='lease' AND value=? AND CAST(value AS INTEGER)>=? RETURNING value",
    )
      .bind(next, lease, now)
      .first();
    if (!renewed) throw Error("Ledger lease expired or changed");
    lease = next;
  };
  env = { ...env, checkpoint };
  try {
    if (data.action === "cooks") return await reportCook(env, data);
    const m = await loadManifest(env.DB, data.round);
    if (!m) return new Response("Manifest missing", { status: 409 });
    const rpc = client(env.BACKUP_RPC_URL),
      receipt = await rpc.getTransactionReceipt({ hash: data.tx as Hex });
    if (
      receipt.status !== "success" ||
      receipt.to?.toLowerCase() !== config.wallets.multisend?.toLowerCase()
    )
      return new Response("Unverified payout", { status: 409 });
    if (
      receipt.blockNumber <= BigInt(m.endBlock) ||
      (await rpc.getBlockNumber()) <
        receipt.blockNumber + BigInt(config.confirmations) - 1n
    )
      return new Response("Payout not finalized", { status: 409 });
    const abi = multisendAbi;
    const batches = payoutBatches(m.payouts);
    const batch = batches.find((batch) =>
      receipt.logs.some((log) => {
        try {
          const event = decodeEventLog({
            abi,
            eventName: "BatchSent",
            data: log.data,
            topics: log.topics,
          });
          return (
            log.address.toLowerCase() ===
              config.wallets.multisend?.toLowerCase() &&
            event.args.batchHash === batch.hash &&
            event.args.sender.toLowerCase() ===
              config.wallets.feed?.toLowerCase() &&
            event.args.amount === batch.value &&
            event.args.recipients === BigInt(batch.to.length) &&
            receipt.logs.some((proof) => {
              if (
                proof.address.toLowerCase() !==
                config.wallets.multisend?.toLowerCase()
              )
                return false;
              try {
                const allocation = decodeEventLog({
                  abi,
                  eventName: "RoundBatchSent",
                  data: proof.data,
                  topics: proof.topics,
                });
                return (
                  allocation.args.round === BigInt(data.round) &&
                  allocation.args.manifestHash === m.hash &&
                  allocation.args.batchIndex === BigInt(batch.index) &&
                  allocation.args.batchHash === batch.hash
                );
              } catch {
                return false;
              }
            })
          );
        } catch {
          return false;
        }
      }),
    );
    if (!batch)
      return new Response("Batch does not match manifest", { status: 409 });
    const existing = await env.DB.prepare(
      "SELECT round,batchHash FROM payout_receipts WHERE LOWER(tx)=?",
    )
      .bind(data.tx)
      .first<{ round: number; batchHash: string }>();
    if (existing) {
      if (existing.round !== data.round || existing.batchHash !== batch.hash)
        return new Response("Receipt already belongs to another payout", {
          status: 409,
        });
      return Response.json({ ok: true });
    }
    await checkpoint();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO payout_receipts VALUES(?,?,?,?,?)").bind(
        data.tx,
        data.round,
        batch.hash,
        Number(receipt.blockNumber),
        (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      ),
      ...batch.to.map((wallet) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO wallet_dirty(wallet) VALUES(?)",
        ).bind(wallet),
      ),
      ...batch.to.map((wallet) =>
        env.DB.prepare(
          "UPDATE payouts SET status='DISTRIBUTED',tx=? WHERE round=? AND wallet=? AND status='PUBLISHED'",
        ).bind(data.tx, data.round, wallet),
      ),
    ]);
    return Response.json({ ok: true });
  } finally {
    await env.DB.prepare("DELETE FROM meta WHERE key='lease' AND value=?")
      .bind(lease)
      .run();
  }
}
