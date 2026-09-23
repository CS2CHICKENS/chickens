import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { finalizePending } from "../src/finalize";
import { flushPublications } from "../src/storage";
import {
  WAD,
  json,
  payoutHash,
  type Round,
  type Token,
} from "../../../packages/core/src/index";
import { client } from "../../../packages/core/src/chain";
import type { Env } from "../src/index";
import type { HatchRecord } from "../../../packages/core/src/engine";
import type { Address } from "viem";

function database() {
  const sql = new DatabaseSync(":memory:");
  for (const name of [
    "0001_initial.sql",
    "0002_receipts.sql",
    "0003_incremental.sql",
    "0005_settlement_pages.sql",
  ])
    sql.exec(readFileSync("apps/worker/migrations/" + name, "utf8"));
  function statement(query: string, args: unknown[] = []): unknown {
    return {
      bind: (...values: unknown[]) => statement(query, values),
      first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
      all: async () => ({
        results: sql.prepare(query).all(...(args as never[])),
        success: true,
      }),
      run: async () => ({
        success: true,
        meta: sql.prepare(query).run(...(args as never[])),
      }),
    };
  }
  const db = {
    prepare: statement,
    batch: async (rows: { run(): Promise<unknown> }[]) => {
      sql.exec("BEGIN");
      try {
        const out = [];
        for (const row of rows) out.push(await row.run());
        sql.exec("COMMIT");
        return out;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const objects = new Map<string, string>();
  let fail = false;
  const env = {
    DB: db,
    DATA: {
      put: async (key: string, value: string) => {
        if (fail) throw Error("R2 unavailable");
        objects.set(key, value);
      },
    },
    ENVIRONMENT: "test",
  } as unknown as Env;
  return {
    sql,
    env,
    objects,
    setFailure: (value: boolean) => {
      fail = value;
    },
  };
}

test("paged settlement checkpoints match full-round payouts and survive publication failure", async () => {
  const f = database();
  const a = "0x1111111111111111111111111111111111111111" as Address;
  const b = "0x2222222222222222222222222222222222222222" as Address;
  const tokens: Token[] = [
    {
      id: "catalana",
      family: "catalana",
      role: "default",
      address: "0x3333333333333333333333333333333333333333",
      pool: "0x4444444444444444444444444444444444444444",
      isToken0: false,
      launchBlock: 1,
    },
    {
      id: "chick",
      role: "chick",
      address: "0x5555555555555555555555555555555555555555",
      pool: "0x6666666666666666666666666666666666666666",
      isToken0: false,
      launchBlock: 1,
    },
  ];
  const base: Round = {
    id: 1,
    startBlock: 5,
    startTs: 1000,
    endBlock: 10,
    endTs: 1010,
    endLogIndex: 0,
    threshold: WAD,
    volumes: { catalana: WAD },
    familyVolumes: { catalana: WAD },
    winner: "catalana",
    reason: "threshold",
    pot: 10000n,
  };
  const rounds = [
    base,
    {
      ...base,
      id: 2,
      startBlock: 11,
      startTs: 1010,
      endBlock: 20,
      endTs: 1020,
    },
  ];
  for (const round of rounds) {
    f.sql
      .prepare("INSERT INTO rounds VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        round.id,
        round.startBlock,
        round.endBlock,
        "1",
        round.winner,
        "PENDING",
        round.pot.toString(),
        round.reason,
        json(round),
      );
    f.sql
      .prepare("INSERT INTO settlement_jobs(round,prices,gasWei) VALUES(?,?,?)")
      .run(round.id, json({ catalana: WAD }), "1");
  }
  const history = [
    { token: "catalana", wallet: a, block: 1, ts: 990, log: 0, delta: WAD },
    { token: "chick", wallet: a, block: 1, ts: 990, log: 1, delta: WAD },
    { token: "catalana", wallet: a, block: 15, ts: 1015, log: 0, delta: -WAD },
    { token: "catalana", wallet: b, block: 15, ts: 1015, log: 1, delta: WAD },
    { token: "chick", wallet: a, block: 15, ts: 1015, log: 2, delta: -WAD },
    { token: "chick", wallet: a, block: 15, ts: 1015, log: 3, delta: WAD },
  ];
  history.forEach((e, i) =>
    f.sql
      .prepare("INSERT INTO balance_events VALUES(?,?,?,?,?,?,?,1)")
      .run(
        String(i),
        e.token,
        e.wallet,
        e.block,
        e.log,
        e.ts,
        e.delta.toString(),
      ),
  );
  f.sql
    .prepare("INSERT INTO current_balances VALUES(?,?,?)")
    .run("catalana", a, "0");
  f.sql
    .prepare("INSERT INTO current_balances VALUES(?,?,?)")
    .run("catalana", b, WAD.toString());
  f.sql
    .prepare("INSERT INTO current_balances VALUES(?,?,?)")
    .run("chick", a, WAD.toString());
  const hatches = rounds.map((round) => ({
    round: round.id,
    family: "catalana",
    hatchAt: round.endTs + 36000,
    remaining: ["catalana-black"],
    block: null,
    hash: null,
    variant: null,
    tokenAddress: null,
  })) as HatchRecord[];
  const rpc = { getCode: async () => undefined } as unknown as ReturnType<
    typeof client
  >;
  await finalizePending(f.env, rpc, tokens, hatches, 1);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) AS n FROM manifests").get()!.n,
    0,
  );
  assert.equal(
    f.sql
      .prepare("SELECT walletCursor FROM settlement_jobs WHERE round=1")
      .get()!.walletCursor,
    a,
  );
  for (let step = 0; step < 8; step++)
    await finalizePending(f.env, rpc, tokens, hatches, 1);
  const expected = [
    [
      { wallet: a, category: "family" as const, amountWei: 6000n },
      { wallet: a, category: "chick" as const, amountWei: 1000n },
    ],
    [
      { wallet: a, category: "family" as const, amountWei: 3000n },
      { wallet: b, category: "family" as const, amountWei: 3000n },
      { wallet: a, category: "chick" as const, amountWei: 1000n },
    ],
  ];
  for (let i = 0; i < 2; i++) {
    const stored = f.sql
      .prepare("SELECT hash,data FROM manifests WHERE round=?")
      .get(i + 1)!;
    assert.equal(stored.hash, payoutHash(i + 1, expected[i]));
    assert.equal(JSON.parse(String(stored.data)).cook.egg, "3000");
  }
  assert.equal(
    f.sql
      .prepare("SELECT streak FROM round_weights WHERE round=1 AND wallet=?")
      .get(a)!.streak,
    1,
  );
  assert.equal(
    f.sql
      .prepare("SELECT streak FROM round_weights WHERE round=2 AND wallet=?")
      .get(a)!.streak,
    0,
  );
  assert.equal(
    f.sql
      .prepare(
        "SELECT balanceWei FROM round_balances WHERE round=1 AND wallet=? AND token='catalana'",
      )
      .get(a)!.balanceWei,
    WAD.toString(),
  );
  f.setFailure(true);
  await assert.rejects(flushPublications(f.env), /R2 unavailable/);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) AS n FROM data_publications").get()!.n,
    2,
  );
  f.setFailure(false);
  await flushPublications(f.env);
  await flushPublications(f.env);
  assert.equal(f.objects.size, 2);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM payouts").get()!.n, 5);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) AS n FROM settlement_jobs").get()!.n,
    0,
  );
  f.sql.close();
});

test("carried rewards survive intervening timeout rounds and expire once", async () => {
  const f = database();
  const wallet = "0x1111111111111111111111111111111111111111" as Address;
  const tokens: Token[] = [
    {
      id: "catalana",
      family: "catalana",
      role: "default",
      address: "0x3333333333333333333333333333333333333333",
      pool: "0x4444444444444444444444444444444444444444",
      isToken0: false,
      launchBlock: 1,
    },
    {
      id: "chick",
      role: "chick",
      address: "0x5555555555555555555555555555555555555555",
      pool: "0x6666666666666666666666666666666666666666",
      isToken0: false,
      launchBlock: 1,
    },
  ];
  for (const token of tokens) {
    f.sql
      .prepare("INSERT INTO current_balances VALUES(?,?,?)")
      .run(token.id, wallet, WAD.toString());
    f.sql
      .prepare("INSERT INTO balance_events VALUES(?,?,?,?,?,?,?,1)")
      .run(token.id, token.id, wallet, 1, 0, 1, WAD.toString());
  }
  for (let id = 1; id <= 4; id++) {
    const round: Round = {
      id,
      startBlock: id * 10,
      startTs: id * 10,
      endBlock: id * 10 + 9,
      endTs: id * 10 + 9,
      endLogIndex: id === 1 ? 0 : null,
      threshold: WAD,
      volumes: { catalana: WAD },
      familyVolumes: { catalana: WAD },
      winner: id === 1 ? "catalana" : null,
      reason: id === 1 ? "threshold" : "timeout",
      pot: 100n,
    };
    f.sql
      .prepare("INSERT INTO rounds VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        round.startBlock,
        round.endBlock,
        "1",
        round.winner,
        "PENDING",
        "100",
        round.reason,
        json(round),
      );
    f.sql
      .prepare("INSERT INTO settlement_jobs(round,prices,gasWei) VALUES(?,?,?)")
      .run(id, json({ catalana: WAD }), "100");
  }
  const hatch: HatchRecord = {
    round: 1,
    family: "catalana",
    hatchAt: 36019,
    remaining: ["catalana-black"],
    block: null,
    hash: null,
    variant: null,
    tokenAddress: null,
  };
  const rpc = { getCode: async () => undefined } as unknown as ReturnType<
    typeof client
  >;
  for (let id = 1; id <= 4; id++) {
    await finalizePending(f.env, rpc, tokens, [hatch]);
    const rows = f.sql.prepare("SELECT amountWei FROM carryover").all();
    assert.equal(
      rows.reduce((sum, row) => sum + BigInt(String(row.amountWei)), 0n),
      id < 4 ? 70n : 0n,
    );
    const manifest = JSON.parse(
      String(
        f.sql.prepare("SELECT data FROM manifests WHERE round=?").get(id)!.data,
      ),
    );
    assert.deepEqual(manifest.payouts, []);
    assert.equal(manifest.cook.egg, id === 1 ? "30" : id === 4 ? "170" : "100");
  }
  await finalizePending(f.env, rpc, tokens, [hatch]);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) AS n FROM manifests").get()!.n,
    4,
  );
  f.sql.close();
});
