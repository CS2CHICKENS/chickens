import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fixture, mockRpc, hash } from "./fixture";
import {
  maintainAccounting,
  publishRoundHistory,
  publishWalletHistory,
  roundHistory,
} from "../src/publication-accounting";
import {
  json,
  WAD,
  type BalanceEvent,
  type Token,
} from "../../../packages/core/src/index";
import { publish, publishWallets } from "../src/publication";
import { walletRound } from "../../../packages/core/src/wallet";

function addRound(
  sql: DatabaseSync,
  id: number,
  winner: string | null = "catalana",
) {
  sql.prepare("INSERT INTO rounds VALUES(?,?,?,?,?,'PUBLISHED',?,?,?)").run(
    id,
    id * 2,
    id * 2 + 1,
    "100",
    winner,
    "71",
    "threshold",
    json({
      id,
      startBlock: id * 2,
      endBlock: id * 2 + 1,
      startTs: id * 2,
      endTs: id * 2 + 1,
      winner,
      pot: 71n,
      threshold: 100n,
      reason: "threshold",
      volumes: {},
      familyVolumes: {},
    }),
  );
}

test("historical accounting drains more than fifty thousand payments exactly and resumes after rollback", async () => {
  const { env, sql, counts } = fixture();
  addRound(sql, 1);
  const insert = sql.prepare("INSERT INTO payouts VALUES(?,?, 'family',?,?,?)");
  let expected = 0n;
  sql.exec("BEGIN");
  for (let n = 0; n < 50001; n++) {
    const amount = 900719925474099300000000000000000000n + BigInt(n);
    const status = n % 3 === 0 ? "PUBLISHED" : "DISTRIBUTED";
    insert.run(
      1,
      "0x" + n.toString(16).padStart(40, "0"),
      amount.toString(),
      status,
      status === "DISTRIBUTED" ? hash(n) : null,
    );
    if (status === "PUBLISHED") expected += amount;
  }
  sql.exec(
    "INSERT INTO split_releases VALUES('one',1,'100000000000000000000000000000000007','3'); INSERT INTO cooks VALUES(1,'egg','23','1','cook'); COMMIT",
  );
  let result = await maintainAccounting(env, 1);
  assert.equal(result.more, true);
  const journalBefore = sql
    .prepare("SELECT COUNT(*) AS n FROM publication_changes")
    .get()!.n;
  const db = env.DB;
  let fail = true;
  env.DB = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (writes: D1PreparedStatement[]) => {
          if (fail) {
            fail = false;
            sql.exec(
              "CREATE TRIGGER abort_publication BEFORE UPDATE ON publication_totals BEGIN SELECT RAISE(ABORT,'interrupted accounting'); END",
            );
          }
          try {
            return await target.batch(writes);
          } finally {
            sql.exec("DROP TRIGGER IF EXISTS abort_publication");
          }
        };
      return Reflect.get(target, key);
    },
  });
  await assert.rejects(
    () => maintainAccounting(env, 1),
    /interrupted accounting/,
  );
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM publication_changes").get()!.n,
    journalBefore,
  );
  env.DB = db;
  let invocations = 1;
  do {
    const before = counts.sql;
    result = await maintainAccounting(env);
    assert.ok(
      counts.sql - before < 180,
      "accounting work per invocation is bounded",
    );
    invocations++;
  } while (result.more);
  assert.ok(invocations > 20 && invocations < 30);
  assert.equal(result.owedWei, expected.toString());
  assert.equal(result.devWei, "100000000000000000000000000000000007");
  const totals = sql
    .prepare("SELECT * FROM publication_round_totals WHERE round=1")
    .get()!;
  assert.equal(totals.unpaidCount, 16667);
  assert.equal(totals.distributedCount, 33334);
  assert.equal(totals.cookedWei, "23");
  sql.exec(
    "UPDATE payouts SET status='DISTRIBUTED',tx='paid' WHERE wallet='0x0000000000000000000000000000000000000000'; DELETE FROM cooks; UPDATE split_releases SET devWei='13'",
  );
  result = await maintainAccounting(env);
  assert.equal(
    result.owedWei,
    (expected - 900719925474099300000000000000000000n).toString(),
  );
  assert.equal(result.devWei, "13");
  assert.equal(
    sql
      .prepare("SELECT cookedWei FROM publication_round_totals WHERE round=1")
      .get()!.cookedWei,
    "0",
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ coins: {} }));
  try {
    const before = counts.sql;
    const { rpc } = mockRpc();
    await publish(
      env,
      rpc,
      [],
      [],
      [],
      null,
      { number: 10, ts: 10, hash: hash(10) },
      { number: 10, ts: 10, hash: hash(10) },
      { wallets: false },
    );
    assert.ok(
      counts.sql - before < 150,
      "state publication does not reload historical payments",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  sql.close();
});

test("wallet continuations refresh a thousand holders in bounded sweeps without marking untouched files fresh", async () => {
  const { env, sql, objects, counts } = fixture(),
    { rpc } = mockRpc();
  const insert = sql.prepare(
    "INSERT INTO current_balances VALUES('chick',?,'100')",
  );
  for (let n = 1; n <= 1000; n++)
    insert.run("0x" + n.toString(16).padStart(40, "0"));
  const last = "0x" + (1000).toString(16).padStart(40, "0");
  objects.set(
    "wallets/" + last + ".json",
    JSON.stringify({ updatedAt: 1, headBlock: 1 }),
  );
  let calls = 0,
    more = true;
  while (more) {
    const before = counts.sql;
    const result = await publishWallets(
      env,
      rpc,
      [],
      {},
      null,
      { number: 100, ts: 100, hash: hash(100) },
      200,
      { limit: 50 },
    );
    more = result.more;
    calls++;
    assert.ok(
      counts.sql - before < 650,
      "wallet batch stays within the D1 query budget",
    );
    assert.ok(result.processed <= 50);
    if (calls === 1)
      assert.equal(
        JSON.parse(objects.get("wallets/" + last + ".json")!).updatedAt,
        1,
      );
  }
  assert.equal(calls, 20);
  assert.equal(objects.size, 1000);
  assert.equal(
    JSON.parse(objects.get("wallets/" + last + ".json")!).headBlock,
    100,
  );
  const empty = await publishWallets(
    env,
    rpc,
    [],
    {},
    null,
    { number: 100, ts: 100, hash: hash(100) },
    300,
  );
  assert.equal(empty.processed, 0);
  assert.equal(empty.more, false);
  assert.equal(
    JSON.parse(objects.get("wallets/" + last + ".json")!).updatedAt,
    200,
  );
  sql.close();
});

test("a wallet with over twenty thousand transfers resumes without blocking other holders", async () => {
  const { env, sql, objects, counts } = fixture(),
    { rpc } = mockRpc();
  const wallet = ("0x" + "1".repeat(40)) as `0x${string}`,
    quiet = ("0x" + "2".repeat(40)) as `0x${string}`;
  const tokens: Token[] = [
    {
      id: "chick",
      address: quiet as `0x${string}`,
      pool: quiet as `0x${string}`,
      isToken0: true,
      launchBlock: 1,
      role: "chick",
    },
  ];
  const active = {
    id: 5,
    startBlock: 10,
    startTs: 100,
    threshold: 100n,
    growthSteps: 0,
    tokens: {},
    families: {},
    creatorFeeWei: 0n,
  };
  const prices = { chick: WAD };
  const events: BalanceEvent[] = [];
  const insert = sql.prepare(
    "INSERT INTO balance_events VALUES(?,?,?,?,?,?,?,1)",
  );
  for (let n = 0; n < 21001; n++) {
    const event = {
      token: "chick",
      wallet,
      block: n + 10,
      logIndex: 0,
      ts: n + 100,
      delta: n % 2 ? -1n : 2n,
    };
    insert.run(
      String(n),
      event.token,
      wallet,
      event.block,
      0,
      event.ts,
      event.delta.toString(),
    );
    events.push(event);
  }
  const closing = 100n + events.reduce((sum, event) => sum + event.delta, 0n);
  sql
    .prepare("INSERT INTO current_balances VALUES('chick',?,?)")
    .run(wallet, closing.toString());
  sql
    .prepare("INSERT INTO current_balances VALUES('chick',?,'100')")
    .run(quiet);
  sql.prepare("INSERT INTO round_weights VALUES(4,?,'0','1',2)").run(wallet);
  const block = { number: 22000, ts: 22090, hash: hash(22000) };
  const first = await publishWallets(
    env,
    rpc,
    tokens,
    prices,
    active,
    block,
    30000,
  );
  assert.equal(first.more, true);
  assert.ok(objects.has(`wallets/${quiet}.json`));
  assert.equal(objects.has(`wallets/${wallet}.json`), false);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM wallet_metric_jobs").get()!.n,
    1,
  );
  const stored = sql
    .prepare("SELECT data FROM wallet_metric_jobs WHERE wallet=?")
    .get(wallet)!.data as string;
  assert.ok(
    stored.length < 5000,
    "the resumable job stores moments, not the event list",
  );
  // A later indexed transfer must not enter the snapshot already being calculated.
  insert.run("later", "chick", wallet, 22001, 0, 22091, "7");
  sql
    .prepare("UPDATE current_balances SET balanceWei=? WHERE wallet=?")
    .run((closing + 7n).toString(), wallet);
  let firstCompleted = false;
  for (let pass = 0; pass < 25; pass++) {
    const before = counts.sql;
    const result = await publishWallets(
      env,
      rpc,
      tokens,
      prices,
      active,
      { number: 22001, ts: 22091, hash: hash(22001) },
      30001 + pass,
    );
    assert.ok(
      counts.sql - before < 30,
      "dense histories advance in bounded event pages",
    );
    if (objects.has(`wallets/${wallet}.json`) && !firstCompleted) {
      const ledger = JSON.parse(objects.get(`wallets/${wallet}.json`)!);
      assert.equal(ledger.headBlock, 22000);
      assert.equal(ledger.updatedAt, 30000);
      const opening = {
        token: "chick",
        wallet,
        block: 9,
        logIndex: -1,
        ts: 99,
        delta: 100n,
      };
      const expected = walletRound(
        wallet,
        [opening, ...events],
        tokens,
        prices,
        100,
        22090,
        [],
        2,
        10,
      );
      assert.equal(ledger.chickWeightWei, expected.chickWeightWei);
      assert.deepEqual(ledger.holdings, expected.holdings);
      assert.ok(
        sql
          .prepare("SELECT wallet FROM wallet_dirty WHERE wallet=?")
          .get(wallet),
      );
      firstCompleted = true;
    }
    if (!result.more) break;
  }
  assert.equal(firstCompleted, true);
  assert.equal(
    JSON.parse(objects.get(`wallets/${wallet}.json`)!).headBlock,
    22001,
  );
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM wallet_metric_jobs").get()!.n,
    0,
  );
  sql.close();
});

test("wallet payment history publishes all older receipts in resumable round ranges", async () => {
  const { env, sql, objects } = fixture(),
    { rpc } = mockRpc();
  const wallet = "0x" + "1".repeat(40);
  const insert = sql.prepare(
    "INSERT INTO payouts VALUES(?,?,?,?, 'DISTRIBUTED',?)",
  );
  let expected = 0n;
  for (let round = 1; round <= 211; round++)
    for (const category of ["family", "chick"]) {
      const amount = 900719925474099300000000000000000n + BigInt(round);
      insert.run(round, wallet, category, amount.toString(), hash(round));
      expected += amount;
    }
  sql.prepare("INSERT INTO wallet_dirty VALUES(?)").run(wallet);
  await publishWallets(
    env,
    rpc,
    [],
    {},
    null,
    { number: 1000, ts: 1000, hash: hash(1000) },
    1000,
  );
  const before = JSON.parse(objects.get(`wallets/${wallet}.json`)!);
  assert.equal(before.received.length, 100);
  assert.equal(before.receivedHasMore, true);
  assert.equal(before.receivedPages.ready, false);
  assert.equal(before.receivedPages.totalPages, 3);
  assert.equal((await publishWalletHistory(env, 1)).more, true);
  const data = env.DATA;
  env.DATA = {
    put: async () => {
      throw Error("interrupted receipt archive");
    },
  } as unknown as R2Bucket;
  await assert.rejects(
    () => publishWalletHistory(env),
    /interrupted receipt archive/,
  );
  env.DATA = data;
  assert.equal((await publishWalletHistory(env, 1)).more, true);
  assert.equal((await publishWalletHistory(env, 1)).more, false);
  let actual = 0n,
    count = 0;
  for (let page = 0; page < 3; page++)
    for (const receipt of JSON.parse(
      objects.get(`wallets/${wallet}/received/${page}.json`)!,
    ).received) {
      actual += BigInt(receipt.amountWei);
      count++;
    }
  assert.equal(count, 422);
  assert.equal(actual, expected);
  await publishWallets(
    env,
    rpc,
    [],
    {},
    null,
    { number: 1000, ts: 1000, hash: hash(1000) },
    1001,
  );
  assert.equal(
    JSON.parse(objects.get(`wallets/${wallet}.json`)!).receivedPages.ready,
    true,
  );
  sql
    .prepare("UPDATE payouts SET tx=? WHERE round=1 AND wallet=?")
    .run(hash(999), wallet);
  assert.equal((await publishWalletHistory(env)).more, false);
  assert.equal(
    JSON.parse(objects.get(`wallets/${wallet}/received/0.json`)!).received.find(
      (receipt: { round: number }) => receipt.round === 1,
    ).tx,
    hash(999),
  );
  sql.close();
});

test("the migration seeds existing ledgers and exact winner counts without numeric wei conversion", () => {
  const sql = new DatabaseSync(":memory:");
  for (const file of readdirSync("apps/worker/migrations")
    .filter((file) => file.endsWith(".sql") && file < "0006")
    .sort())
    sql.exec(readFileSync("apps/worker/migrations/" + file, "utf8"));
  addRound(sql, 1);
  sql.exec(
    "INSERT INTO payouts VALUES(1,'wallet','family','900719925474099300000000000000001','PUBLISHED',NULL); INSERT INTO split_releases VALUES('release',1,'23','23'); INSERT INTO cooks VALUES(1,'egg','31','47','cook')",
  );
  sql.exec(readFileSync("apps/worker/migrations/0006_publication.sql", "utf8"));
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM publication_changes").get()!.n,
    3,
  );
  assert.equal(
    sql
      .prepare("SELECT owedWei FROM publication_changes WHERE unpaidDelta=1")
      .get()!.owedWei,
    "900719925474099300000000000000001",
  );
  assert.equal(
    sql.prepare("SELECT wins FROM history_wins WHERE family='catalana'").get()!
      .wins,
    1,
  );
  sql.close();
});

test("round archives cover older rounds in bounded pages and retry failed writes", async () => {
  const { env, sql, objects, counts } = fixture();
  for (let id = 1; id <= 301; id++)
    addRound(sql, id, id % 2 ? "catalana" : "silkie");
  sql
    .prepare("INSERT INTO manifests VALUES(1,?,?)")
    .run(hash(1), json({ cook: { egg: "23" } }));
  sql.exec("INSERT INTO cooks VALUES(1,'egg','23','7','cook')");
  await maintainAccounting(env);
  const data = env.DATA;
  env.DATA = {
    put: async () => {
      throw Error("storage unavailable");
    },
  } as unknown as R2Bucket;
  await assert.rejects(() => publishRoundHistory(env), /storage unavailable/);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM history_dirty").get()!.n,
    4,
  );
  env.DATA = data;
  let result = await publishRoundHistory(env, 1);
  assert.equal(result.more, true);
  assert.equal(
    JSON.parse(objects.get("history/rounds/0.json")!).rounds.length,
    100,
  );
  const before = counts.sql;
  result = await publishRoundHistory(env, 2);
  assert.ok(counts.sql - before < 210);
  assert.equal(result.more, true);
  result = await publishRoundHistory(env, 2);
  assert.equal(result.more, false);
  assert.equal(
    JSON.parse(objects.get("history/rounds/3.json")!).rounds[0].id,
    301,
  );
  assert.equal(
    (await roundHistory(env, 1, 1))[0].settlementStatus,
    "distributed",
  );
  const receipt = sql.prepare(
    "INSERT INTO payout_receipts VALUES(?,1,?,?, '1')",
  );
  for (let index = 0; index < 101; index++)
    receipt.run(hash(index), hash(index + 1000), index);
  const capped = (await roundHistory(env, 1, 1))[0];
  assert.equal(capped.payoutTransactions.length, 100);
  assert.equal(capped.payoutTransactionsHasMore, true);
  assert.equal(
    sql.prepare("SELECT wins FROM history_wins WHERE family='catalana'").get()!
      .wins,
    151,
  );
  sql.exec("UPDATE rounds SET status='DISTRIBUTED' WHERE id=1");
  assert.equal(
    sql.prepare("SELECT wins FROM history_wins WHERE family='catalana'").get()!
      .wins,
    151,
  );
  sql.exec("UPDATE rounds SET winner='silkie' WHERE id=1");
  assert.equal(
    sql.prepare("SELECT wins FROM history_wins WHERE family='catalana'").get()!
      .wins,
    150,
  );
  assert.equal(
    sql.prepare("SELECT wins FROM history_wins WHERE family='silkie'").get()!
      .wins,
    151,
  );
  sql.close();
});
