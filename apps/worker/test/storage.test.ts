import test from "node:test";
import assert from "node:assert/strict";
import worker, { tick } from "../src/index";
import { finalizePending } from "../src/finalize";
import { flushPublications } from "../src/storage";
import { derive } from "../src/engine";
import { initialTokens } from "../src/indexer";
import { config, WAD, json } from "../../../packages/core/src/index";
import { fixture, mockRpc, holder, hash } from "./fixture";
const request = (body: unknown) =>
  new Request("https://local.test/admin/state", {
    method: "POST",
    headers: { "x-admin-secret": "local-fixture-only" },
    body: JSON.stringify(body),
  });
test("a rule change cannot silently reprice an indexed round", async () => {
  const { env, sql } = fixture(),
    { rpc } = mockRpc();
  const original = config.round.minDurationSec;
  try {
    await withoutUsd(() => tick(env, { rpc }));
    const active = sql
      .prepare("SELECT value FROM meta WHERE key='active'")
      .get()!.value;
    config.round.minDurationSec = 1;
    await withoutUsd(() => tick(env, { rpc }));
    assert.equal(
      sql.prepare("SELECT value FROM meta WHERE key='paused'").get()!.value,
      "true",
    );
    assert.equal(
      sql.prepare("SELECT value FROM meta WHERE key='active'").get()!.value,
      active,
    );
    assert.equal(
      sql
        .prepare("SELECT COUNT(*) n FROM alerts WHERE id='rules-changed'")
        .get()!.n,
      1,
    );
  } finally {
    config.round.minDurationSec = original;
    sql.close();
  }
});
async function withoutUsd<T>(run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ coins: {} }));
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("first verified family trade starts round one without payout contracts", async () => {
  const { env, sql, objects, counts } = fixture(),
    { rpc, counts: rpcCounts } = mockRpc();
  await withoutUsd(() => tick(env, { rpc }));
  const state = JSON.parse(objects.get("state.json")!);
  assert.equal(state.mode, "live");
  assert.equal(state.round.id, 1);
  assert.equal(state.round.endsBy, 0);
  assert.equal(state.round.threshold, (100n * WAD).toString());
  assert.equal(state.tokens.length, 5);
  assert.equal(state.ticker.length, 1);
  assert.equal(state.feed.generatedWei, "17000000000000000");
  assert.equal(state.feed.claimableWei, "0");
  assert.equal(state.feed.collectedWei, null);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM current_balances").get()!.n,
    5,
  );
  assert.ok(
    rpcCounts.blocks < 30,
    "sparse headers must not fetch each of 10000 blocks",
  );
  assert.ok(counts.sql < 300, "monitoring stays below the paid D1 query limit");
  const before = sql
    .prepare("SELECT balanceWei FROM current_balances WHERE token='catalana'")
    .get()!.balanceWei;
  await withoutUsd(() => tick(env, { rpc }));
  assert.equal(
    sql
      .prepare("SELECT balanceWei FROM current_balances WHERE token='catalana'")
      .get()!.balanceWei,
    before,
  );
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM swaps").get()!.n, 1);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='lease'").get()!.n,
    0,
  );
  sql.close();
});

test("admin denies public requests and allows read-only monitoring resume", async () => {
  const { env, sql } = fixture();
  assert.equal(
    (await worker.fetch(new Request("https://local.test/"), env)).status,
    404,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://local.test/admin/pause", { method: "POST" }),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (await worker.fetch(request({ action: "pause" }), env)).status,
    200,
  );
  assert.equal(
    (await worker.fetch(request({ action: "resume" }), env)).status,
    200,
  );
  assert.equal(
    (await worker.fetch(request({ action: "unknown" }), env)).status,
    400,
  );
  sql.close();
});

test("reindex clears orphaned variants and releases and refuses concurrent indexing", async () => {
  const { env, sql, objects } = fixture();
  const block = config.factoryStartBlock;
  sql.exec(
    "INSERT INTO meta VALUES('paused','true'); INSERT INTO tokens(address,id,family,role,pool,isToken0,launchBlock) VALUES('variant','variant','catalana','variant','pool',1," +
      block +
      "); INSERT INTO split_releases VALUES('receipt'," +
      block +
      ",'50','50');",
  );
  sql
    .prepare("INSERT INTO meta VALUES('lease',?)")
    .run(String(Math.floor(Date.now() / 1000) + 600));
  assert.equal(
    (await worker.fetch(request({ action: "reindex", block }), env)).status,
    409,
  );
  sql.exec("DELETE FROM meta WHERE key='lease'");
  assert.equal(
    (await worker.fetch(request({ action: "reindex", block }), env)).status,
    200,
  );
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM tokens").get()!.n, 0);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM split_releases").get()!.n,
    0,
  );
  assert.equal(JSON.parse(objects.get("state.json")!).mode, "unconfigured");
  sql.close();
});

test("staged reorg pauses before applying orphaned balances", async () => {
  const { env, sql } = fixture(),
    { rpc } = mockRpc();
  sql
    .prepare("INSERT INTO meta VALUES('stagedRange',?)")
    .run(JSON.stringify({ to: config.factoryStartBlock + 100, hash: hash(1) }));
  await tick(env, { rpc });
  assert.equal(
    sql.prepare("SELECT value FROM meta WHERE key='paused'").get()!.value,
    "true",
  );
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM current_balances").get()!.n,
    0,
  );
  sql.close();
});

test("paged settlement commits its manifest once and retries publication safely", async () => {
  const { env, sql, objects } = fixture(),
    { rpc } = mockRpc();
  const tokens = await initialTokens(rpc);
  const start = config.factoryStartBlock + 5000;
  const blocks = Array.from({ length: 30 }, (_, i) => ({
    number: start + i,
    ts: 1000 + i,
    hash: hash(start + i),
  }));
  const state = derive(
      [
        {
          token: "catalana",
          family: "catalana",
          block: start + 6,
          ts: 1006,
          logIndex: 2,
          volume: 10n * WAD,
          creatorFeeWei: WAD / 10n,
          feeVerified: true,
          side: "buy",
          wallet: holder,
          tx: hash(start + 6),
        },
      ],
      blocks,
      start,
      WAD,
      true,
    ),
    round = state.rounds[0];
  sql
    .prepare("INSERT INTO rounds VALUES(?,?,?,?,?,'PENDING',?,?,?)")
    .run(
      round.id,
      round.startBlock,
      round.endBlock,
      round.threshold.toString(),
      round.winner,
      round.pot.toString(),
      round.reason,
      json(round),
    );
  sql
    .prepare(
      "INSERT INTO balance_events(id,token,wallet,block,logIndex,ts,delta,applied) VALUES('mint','catalana',?,?,0,1,?,1)",
    )
    .run(holder, config.tokenLaunchBlocks.catalana, WAD.toString());
  sql
    .prepare("INSERT INTO current_balances VALUES('catalana',?,?)")
    .run(holder, WAD.toString());
  await finalizePending(env, rpc, tokens, state.hatches, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM manifests").get()!.n, 0);
  await finalizePending(env, rpc, tokens, state.hatches, 1);
  await flushPublications(env);
  const first = objects.get("payouts/1.json")!;
  assert.ok(first);
  objects.clear();
  sql
    .prepare("INSERT INTO data_publications VALUES('payouts/1.json',?)")
    .run(first);
  await flushPublications(env);
  await finalizePending(env, rpc, tokens, state.hatches, 1);
  assert.equal(objects.get("payouts/1.json"), first);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM manifests").get()!.n, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM payouts").get()!.n, 1);
  sql.close();
});

test("a stale lease owner cannot write a fetched chunk or release its replacement", async () => {
  const { env, sql } = fixture(),
    { rpc } = mockRpc();
  let replaced = false;
  const replacement = String(Math.floor(Date.now() / 1000) + 9999);
  const rival = new Proxy(rpc, {
    get(target, key) {
      if (key === "getContractEvents")
        return async (...args: unknown[]) => {
          if (!replaced) {
            replaced = true;
            sql
              .prepare("UPDATE meta SET value=? WHERE key='lease'")
              .run(replacement);
          }
          return (
            target.getContractEvents as (...args: unknown[]) => Promise<unknown>
          )(...args);
        };
      return Reflect.get(target, key);
    },
  });
  await assert.rejects(
    () => tick(env, { rpc: rival }),
    /lease expired or changed/,
  );
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM swaps").get()!.n, 0);
  assert.equal(
    sql.prepare("SELECT COUNT(*) n FROM balance_events").get()!.n,
    0,
  );
  assert.equal(
    sql.prepare("SELECT value FROM meta WHERE key='lease'").get()!.value,
    replacement,
  );
  sql.close();
});

test("activating a past start never skips already indexed game trades", async () => {
  const { env, sql, objects } = fixture(),
    { rpc } = mockRpc();
  const old = { ...config.round };
  try {
    config.round.firstThresholdEth = null;
    await withoutUsd(() => tick(env, { rpc }));
    config.round.startBlock = config.factoryStartBlock + 1;
    config.round.firstThresholdEth = "1";
    await withoutUsd(() => tick(env, { rpc }));
    assert.equal(JSON.parse(objects.get("state.json")!).mode, "monitoring");
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM rounds").get()!.n, 0);
    assert.equal(
      sql
        .prepare("SELECT COUNT(*) n FROM alerts WHERE id='round-start-passed'")
        .get()!.n,
      1,
    );
  } finally {
    Object.assign(config.round, old);
    sql.close();
  }
});

test("a scheduled index failure retains its alert without external notifications", async () => {
  const { env, sql } = fixture();
  let fail = true;
  const database = env.DB;
  env.DB = new Proxy(database, {
    get(target, key) {
      if (key === "prepare")
        return (query: string) => {
          if (fail && query.includes("INSERT INTO meta")) {
            fail = false;
            throw Error("fixture index failure");
          }
          return target.prepare(query);
        };
      return Reflect.get(target, key);
    },
  });
  const original = globalThis.fetch;
  let sent = 0,
    pending: Promise<unknown> | undefined;
  globalThis.fetch = async () => {
    sent++;
    throw Error("Unexpected outbound request");
  };
  try {
    await worker.scheduled({} as ScheduledController, env, {
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    } as ExecutionContext);
    await pending;
    assert.equal(sent, 0);
    assert.equal(
      sql.prepare("SELECT message FROM alerts WHERE id='tick-failed'").get()!
        .message,
      "Indexer failed; last verified state retained.",
    );
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM outbox").get()!.n, 0);
  } finally {
    globalThis.fetch = original;
    sql.close();
  }
});
