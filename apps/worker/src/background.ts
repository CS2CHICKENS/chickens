import { config, roundsReady } from "../../../packages/core/src/index";
import { client, tokenSnapshot } from "../../../packages/core/src/chain";
import { tick, storedTokens, storedHatches, type Env } from "./index";
import { headers, type Rpc } from "./indexer";
import { withLedgerLease } from "./lease";
import { alert, meta, putMeta, flushPublications } from "./storage";
import { publish, publishWallets, reviveActive } from "./publication";
import { finalizePending } from "./finalize";
import { advanceFeeClaims } from "./fee-claims";
import { scheduleWork, type WorkKind } from "./work-queue";

export async function executeBackground(
  env: Env,
  kind: WorkKind,
  providedRpc?: Rpc,
): Promise<boolean> {
  if (kind === "index")
    return !!(await tick(env, { queued: true, rpc: providedRpc }));
  return !!(await withLedgerLease(env, async (locked) => {
    if ((await meta(locked.DB, "paused")) === "true") return false;
    if (await meta(locked.DB, "stagedRange")) {
      await scheduleWork(locked, "index");
      return false;
    }
    const cursor = Number((await meta(locked.DB, "cursor")) ?? -1);
    const start = Number(
      (await meta(locked.DB, "indexStart")) ?? config.factoryStartBlock,
    );
    if (cursor < start) return false;
    const rpc = providedRpc ?? client(locked.BACKUP_RPC_URL);
    const saved = await locked.DB.prepare(
      "SELECT hash FROM blocks WHERE number=?",
    )
      .bind(cursor)
      .first<{ hash: string }>();
    const [indexed] = await headers(rpc, [cursor]);
    if (!saved || indexed.hash !== saved.hash) {
      await putMeta(locked.DB, "paused", "true");
      await alert(
        locked,
        "background-reorg",
        "Confirmed block changed; engine paused for re-index.",
      );
      return false;
    }
    const tokens = await storedTokens(locked);
    if (kind === "fees") {
      const result = await advanceFeeClaims(locked, rpc, tokens, cursor);
      await scheduleWork(locked, "publication");
      return result.more;
    }
    if (kind === "settlement") {
      if (roundsReady())
        await finalizePending(
          locked,
          rpc,
          tokens,
          await storedHatches(locked),
          100,
        );
      await flushPublications(locked);
      await scheduleWork(locked, "publication");
      return (
        roundsReady() &&
        !!(await locked.DB.prepare(
          "SELECT id FROM rounds WHERE status='PENDING' LIMIT 1",
        ).first())
      );
    }
    const active = roundsReady()
      ? reviveActive(await meta(locked.DB, "active"))
      : null;
    if (kind === "wallets") {
      const prices: Record<string, bigint> = {};
      for (const token of tokens) {
        if (token.launchBlock > cursor) continue;
        await locked.checkpoint?.();
        prices[token.id] = (
          await tokenSnapshot(rpc, token.address, BigInt(cursor))
        ).priceWei;
      }
      const result = await publishWallets(
        locked,
        rpc,
        tokens,
        prices,
        active,
        indexed,
        Math.floor(Date.now() / 1000),
      );
      if (!result.more) await putMeta(locked.DB, "walletRefreshCursor", "");
      return result.more;
    }
    const head = await rpc.getBlockNumber();
    const safeNumber = Number(head - BigInt(config.confirmations));
    if (safeNumber < cursor)
      throw Error("Confirmed head behind indexed cursor");
    const [safe] =
      safeNumber === cursor ? [indexed] : await headers(rpc, [safeNumber]);
    await publish(
      locked,
      rpc,
      tokens,
      [],
      await storedHatches(locked),
      active,
      indexed,
      safe,
      { wallets: false },
    );
    return (
      !!(await locked.DB.prepare(
        "SELECT sequence FROM publication_changes LIMIT 1",
      ).first()) ||
      !!(await locked.DB.prepare(
        "SELECT page FROM history_dirty LIMIT 1",
      ).first()) ||
      !!(await locked.DB.prepare(
        "SELECT page FROM wallet_history_dirty LIMIT 1",
      ).first())
    );
  }));
}
