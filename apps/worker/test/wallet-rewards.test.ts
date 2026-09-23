import test from "node:test";
import assert from "node:assert/strict";
import { fixture, mockRpc, hash } from "./fixture";
import { publishWallets } from "../src/publication";
import { walletRewards } from "../src/wallet-rewards";
import { walletLedgerSchema } from "../../../packages/core/src/state";

const wallet = "0x" + "1".repeat(40);
const block = { number: 100, ts: 100, hash: hash(100) };

test("pending wallet rewards include only published amounts and resume exact totals beyond a single page", async () => {
  const { env, sql, objects, counts } = fixture(),
    { rpc } = mockRpc();
  const insert = sql.prepare("INSERT INTO payouts VALUES(?,?,?,?,?,?)");
  let total = 0n;
  for (let round = 1; round <= 5001; round++) {
    const amount = 9007199254740993000000000000000000n + BigInt(round);
    insert.run(round, wallet, "family", amount.toString(), "PUBLISHED", null);
    total += amount;
  }
  insert.run(
    7000,
    wallet,
    "family",
    "99999999999999999999999999999999999999999999",
    "PREPARED",
    null,
  );
  insert.run(
    7001,
    wallet,
    "chick",
    "88888888888888888888888888888888888888888888",
    "DISTRIBUTED",
    hash(7001),
  );
  const first = await publishWallets(env, rpc, [], {}, null, block, 100);
  assert.equal(first.more, true);
  const partial = walletLedgerSchema.parse(
    JSON.parse(objects.get(`wallets/${wallet}.json`)!),
  ).pendingRewards!;
  assert.equal(partial.ready, false);
  assert.equal(partial.totalWei, null);
  assert.equal(partial.count, null);
  assert.equal(partial.latest.length, 100);
  assert.equal(partial.hasMore, true);
  assert.equal(partial.latest[0].round, 5001);
  let passes = 1,
    more = true;
  while (more) {
    const before = counts.sql;
    const result = await publishWallets(
      env,
      rpc,
      [],
      {},
      null,
      block,
      100 + passes,
    );
    assert.ok(counts.sql - before < 25);
    more = result.more;
    passes++;
  }
  assert.equal(passes, 6);
  const complete = walletLedgerSchema.parse(
    JSON.parse(objects.get(`wallets/${wallet}.json`)!),
  ).pendingRewards!;
  assert.equal(complete.ready, true);
  assert.equal(complete.totalWei, total.toString());
  assert.equal(complete.count, 5001);
  sql
    .prepare(
      "UPDATE payouts SET status='DISTRIBUTED',tx=? WHERE round=5001 AND wallet=?",
    )
    .run(hash(5001), wallet);
  await publishWallets(env, rpc, [], {}, null, block, 107);
  const paid = walletLedgerSchema.parse(
    JSON.parse(objects.get(`wallets/${wallet}.json`)!),
  );
  assert.equal(
    paid.pendingRewards!.totalWei,
    (total - 9007199254740993000000000000005001n).toString(),
  );
  assert.equal(paid.pendingRewards!.count, 5000);
  assert.equal(
    paid.pendingRewards!.latest.some((row) => row.round === 5001),
    false,
  );
  assert.ok(paid.received.some((row) => row.round === 5001));
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM wallet_reward_changes").get()!.n,
    0,
  );
  sql.close();
});

test("reward aggregate consumption is atomic and published transitions remain separate from carry-over", async () => {
  const { env, sql } = fixture();
  sql
    .prepare("INSERT INTO payouts VALUES(1,?,'family','19','PREPARED',NULL)")
    .run(wallet);
  sql.prepare("INSERT INTO carryover VALUES(?,1,'chick','41')").run(wallet);
  assert.equal((await walletRewards(env, wallet)).pending.totalWei, "0");
  sql
    .prepare("UPDATE payouts SET status='PUBLISHED' WHERE wallet=?")
    .run(wallet);
  const prepared = await walletRewards(env, wallet);
  assert.equal(prepared.pending.totalWei, "19");
  sql.exec(
    "CREATE TRIGGER interrupt_wallet_rewards BEFORE DELETE ON wallet_reward_changes BEGIN SELECT RAISE(ABORT,'interrupted'); END",
  );
  await assert.rejects(() => env.DB.batch(prepared.writes), /interrupted/);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM wallet_reward_totals").get()!.n,
    0,
  );
  sql.exec("DROP TRIGGER interrupt_wallet_rewards");
  const retry = await walletRewards(env, wallet);
  await env.DB.batch(retry.writes);
  assert.equal((await walletRewards(env, wallet)).pending.totalWei, "19");
  sql.prepare("DELETE FROM payouts WHERE wallet=?").run(wallet);
  const removed = await walletRewards(env, wallet);
  assert.equal(removed.pending.totalWei, "0");
  assert.equal(removed.pending.count, 0);
  await env.DB.batch(removed.writes);
  assert.equal(
    sql.prepare("SELECT amountWei FROM carryover WHERE wallet=?").get(wallet)!
      .amountWei,
    "41",
  );
  sql.close();
});
