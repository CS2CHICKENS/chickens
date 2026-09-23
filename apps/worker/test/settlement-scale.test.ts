import test from "node:test";
import assert from "node:assert/strict";
import { type Address } from "viem";
import {
  WAD,
  json,
  type Round,
  type Token,
} from "../../../packages/core/src/index";
import {
  buildManifest,
  type HatchRecord,
} from "../../../packages/core/src/engine";
import { finalizePending } from "../src/finalize";
import { loadManifest, loadManifestJson } from "../src/manifests";
import { flushPublications } from "../src/storage";
import { fixture, mockRpc } from "./fixture";
import { compareManifest } from "../../../scripts/operator-plan";
import { payoutBatches } from "../../../packages/core/src/batches";
import { withLedgerLease } from "../src/lease";

const wallet = (index: number) =>
  ("0x" + (1000 + index).toString(16).padStart(40, "0")) as Address;
const tokens: Token[] = [
  {
    id: "catalana",
    family: "catalana",
    role: "default",
    address: wallet(30000),
    pool: wallet(30001),
    isToken0: false,
    launchBlock: 1,
  },
  {
    id: "chick",
    role: "chick",
    address: wallet(30002),
    pool: wallet(30003),
    isToken0: false,
    launchBlock: 1,
  },
];
const round: Round = {
  id: 1,
  startBlock: 2,
  endBlock: 3,
  startTs: 2,
  endTs: 3,
  endLogIndex: 0,
  threshold: 100n * WAD,
  pot: 101n * WAD + 7n,
  creatorFeeWei: 202n * WAD + 15n,
  winner: "catalana",
  reason: "threshold",
  volumes: { catalana: 100n * WAD },
  familyVolumes: { catalana: 100n * WAD },
};
const hatch = { round: 1 } as HatchRecord;

function seedRound(f: ReturnType<typeof fixture>) {
  f.sql
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
  f.sql
    .prepare("INSERT INTO settlement_jobs(round,prices,gasWei) VALUES(?,?,?)")
    .run(1, json({ catalana: WAD }), "1");
}

test("ten thousand recipients preserve the complete manifest through page, ledger and R2 interruptions", async () => {
  const f = fixture(),
    { rpc } = mockRpc();
  seedRound(f);
  const computed = {
    family: {} as Record<string, bigint>,
    chick: {} as Record<string, bigint>,
    streaks: {} as Record<string, number>,
  };
  f.sql.exec("BEGIN");
  for (let index = 0; index < 10000; index++) {
    const address = wallet(index),
      amount = BigInt(index + 1) * WAD;
    computed.family[address] = amount;
    computed.chick[address] = (amount * 3n) / 2n;
    computed.streaks[address] = 1;
    f.sql
      .prepare("INSERT INTO round_weights VALUES(?,?,?,?,?)")
      .run(
        1,
        address,
        amount.toString(),
        computed.chick[address].toString(),
        1,
      );
  }
  f.sql.exec("COMMIT");
  const expected = buildManifest(round, computed, [], 1n, 1, tokens);
  assert.equal(expected.payouts.length, 20000);
  assert.ok(new TextEncoder().encode(json(expected)).byteLength > 3900000);
  let interrupted = false;
  f.env.checkpoint = async () => {
    if (
      !interrupted &&
      Number(
        f.sql.prepare("SELECT COUNT(*) n FROM settlement_pages").get()!.n,
      ) >= 3
    ) {
      interrupted = true;
      throw Error("interrupted page write");
    }
  };
  await assert.rejects(
    finalizePending(f.env, rpc, tokens, [hatch]),
    /interrupted page write/,
  );
  assert.equal(
    f.sql.prepare("SELECT data FROM settlement_jobs").get()!.data,
    null,
  );
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM payouts").get()!.n, 0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM manifests").get()!.n, 0);
  f.env.checkpoint = async () => {};
  let maxQueries = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const before = f.counts.sql;
    await finalizePending(f.env, rpc, tokens, [hatch]);
    maxQueries = Math.max(maxQueries, f.counts.sql - before);
    if (attempt === 0) {
      assert.equal(
        f.sql.prepare("SELECT writeOffset FROM settlement_jobs").get()!
          .writeOffset,
        1000,
      );
      f.env.checkpoint = async () => {
        throw Error("interrupted ledger write");
      };
      await assert.rejects(
        finalizePending(f.env, rpc, tokens, [hatch]),
        /interrupted ledger write/,
      );
      assert.equal(
        f.sql.prepare("SELECT writeOffset FROM settlement_jobs").get()!
          .writeOffset,
        1000,
      );
      f.env.checkpoint = async () => {};
    }
    if (f.sql.prepare("SELECT COUNT(*) n FROM manifests").get()!.n) break;
  }
  assert.ok(maxQueries < 800);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM payouts").get()!.n, 20000);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) n FROM settlement_jobs").get()!.n,
    0,
  );
  assert.ok(
    Number(
      f.sql
        .prepare(
          "SELECT MAX(LENGTH(CAST(data AS BLOB))) n FROM settlement_pages",
        )
        .get()!.n,
    ) <= 128000,
  );
  assert.ok(
    Number(f.sql.prepare("SELECT LENGTH(data) n FROM manifests").get()!.n) <
      2000,
  );
  assert.ok(
    Number(
      f.sql.prepare("SELECT LENGTH(value) n FROM data_publications").get()!.n,
    ) < 200,
  );
  const loaded = (await loadManifest(f.env.DB, 1))!;
  assert.deepEqual(loaded, expected);
  const batches = payoutBatches(loaded.payouts);
  assert.equal(batches.length, 50);
  assert.ok(batches.every((batch) => batch.to.length === 200));
  assert.deepEqual(batches, payoutBatches(expected.payouts));
  assert.equal(
    batches.reduce((sum, batch) => sum + batch.value, 0n),
    expected.payouts.reduce((sum, row) => sum + BigInt(row.amountWei), 0n),
  );
  assert.equal(await loadManifestJson(f.env.DB, 1), json(expected));
  const put = f.env.DATA.put;
  f.env.DATA.put = async () => {
    throw Error("R2 unavailable");
  };
  await assert.rejects(flushPublications(f.env), /R2 unavailable/);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) n FROM data_publications").get()!.n,
    1,
  );
  f.env.DATA.put = put;
  await flushPublications(f.env);
  await flushPublications(f.env);
  assert.equal(f.objects.get("payouts/1.json"), json(expected));
  compareManifest(expected, JSON.parse(f.objects.get("payouts/1.json")!));
  const paid = expected.payouts.reduce(
    (sum, row) => sum + BigInt(row.amountWei),
    0n,
  );
  assert.equal(
    paid +
      Object.values(expected.cook).reduce(
        (sum, value) => sum + BigInt(value),
        0n,
      ),
    round.pot,
  );
  f.sql
    .prepare(
      "UPDATE settlement_pages SET data=data||' ' WHERE round=1 AND page=0",
    )
    .run();
  await assert.rejects(loadManifest(f.env.DB, 1), /commitment mismatch/);
  f.sql.close();
});

test("wallet processing batches SQL and limits parallel archive calls without skipping failed groups", async () => {
  const f = fixture(),
    { rpc } = mockRpc();
  seedRound(f);
  for (let index = 0; index < 150; index++) {
    const address = wallet(index);
    for (const token of tokens) {
      f.sql
        .prepare("INSERT INTO current_balances VALUES(?,?,?)")
        .run(token.id, address, WAD.toString());
      f.sql
        .prepare("INSERT INTO balance_events VALUES(?,?,?,?,?,?,?,1)")
        .run(token.id + index, token.id, address, 1, 0, 1, WAD.toString());
    }
  }
  let active = 0,
    maximum = 0,
    failed = false;
  rpc.getCode = (async ({ address }: { address: string }) => {
    active++;
    maximum = Math.max(active, maximum);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (!failed && address === wallet(60)) {
      failed = true;
      throw Error("archive unavailable");
    }
    return undefined;
  }) as typeof rpc.getCode;
  await assert.rejects(
    finalizePending(f.env, rpc, tokens, [hatch], 150),
    /archive unavailable/,
  );
  assert.equal(
    f.sql.prepare("SELECT walletCursor FROM settlement_jobs").get()!
      .walletCursor,
    wallet(49),
  );
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) n FROM round_weights").get()!.n,
    50,
  );
  const before = f.counts.sql;
  await finalizePending(f.env, rpc, tokens, [hatch], 150);
  assert.ok(
    f.counts.sql - before < 80,
    "remaining 100 wallets use batched SQL",
  );
  assert.ok(maximum <= 6);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) n FROM round_weights").get()!.n,
    150,
  );
  const result = (await loadManifest(f.env.DB, 1))!;
  assert.equal(result.payouts.length, 300);
  assert.equal(Object.keys(result.weights.family).length, 150);
  f.sql.close();
});

test("inline manifests remain readable and missing committed pages fail closed", async () => {
  const f = fixture();
  const expected = buildManifest(
    round,
    { family: {}, chick: {}, streaks: {} },
    [],
    1n,
    1,
    tokens,
  );
  f.sql
    .prepare("INSERT INTO manifests VALUES(?,?,?)")
    .run(1, expected.hash, json(expected));
  assert.deepEqual(await loadManifest(f.env.DB, 1), expected);
  assert.equal(await loadManifest(f.env.DB, 2), null);
  f.sql.prepare("UPDATE manifests SET data=? WHERE round=1").run(
    json({
      ...expected,
      storage: { version: 1, pages: 1, bytes: 1, contentHash: "0x00" },
    }),
  );
  await assert.rejects(loadManifest(f.env.DB, 1), /Incomplete manifest pages/);
  f.sql.close();
});

test("ten thousand holders with three rounds of carried categories exceed fifty thousand rows without a query cutoff", async () => {
  const f = fixture(),
    { rpc } = mockRpc();
  const current = { ...round, id: 4, pot: 100n };
  f.sql
    .prepare("INSERT INTO rounds VALUES(?,?,?,?,?,'PENDING',?,?,?)")
    .run(
      4,
      current.startBlock,
      current.endBlock,
      current.threshold.toString(),
      current.winner,
      current.pot.toString(),
      current.reason,
      json(current),
    );
  f.sql
    .prepare(
      "INSERT INTO settlement_jobs(round,prices,gasWei,walletCursor) VALUES(?,?,?,?)",
    )
    .run(4, json({ catalana: WAD }), "100", wallet(9999));
  const previous: {
    wallet: Address;
    round: number;
    category: "family" | "chick";
    amountWei: bigint;
  }[] = [];
  const computed = {
    family: {} as Record<string, bigint>,
    chick: {} as Record<string, bigint>,
    streaks: {} as Record<string, number>,
  };
  f.sql.exec("BEGIN");
  for (let index = 0; index < 10000; index++) {
    const address = wallet(index);
    computed.family[address] = WAD;
    computed.chick[address] = WAD;
    computed.streaks[address] = 0;
    f.sql
      .prepare("INSERT INTO round_weights VALUES(?,?,?,?,?)")
      .run(4, address, WAD.toString(), WAD.toString(), 0);
    for (let id = 1; id <= 3; id++)
      for (const category of ["family", "chick"] as const) {
        previous.push({ wallet: address, round: id, category, amountWei: 1n });
        f.sql
          .prepare("INSERT INTO carryover VALUES(?,?,?,?)")
          .run(address, id, category, "1");
      }
  }
  f.sql.exec("COMMIT");
  assert.equal(previous.length, 60000);
  const expected = buildManifest(current, computed, previous, 100n, 1, tokens);
  const before = f.counts.sql;
  await withLedgerLease(f.env, (locked) =>
    finalizePending(locked, rpc, tokens, [{ round: 4 } as HatchRecord]),
  );
  assert.ok(f.counts.sql - before < 800);
  const summary = JSON.parse(
    String(
      f.sql.prepare("SELECT data FROM settlement_jobs WHERE round=4").get()!
        .data,
    ),
  );
  const actual = (await loadManifest(f.env.DB, 4, summary))!;
  assert.deepEqual(actual, expected);
  compareManifest(expected, actual);
  assert.equal(actual.cook.egg, "20100");
  assert.equal(
    actual.carry.reduce((sum, row) => sum + BigInt(row.amountWei), 0n),
    40000n,
  );
  f.sql.close();
});

test("Rabby reconstruction agrees after carried categories pass through D1 between rounds", async () => {
  const f = fixture(),
    { rpc } = mockRpc();
  let previous: Parameters<typeof buildManifest>[2] = [];
  const computed = {
    family: { [wallet(0)]: WAD },
    chick: { [wallet(0)]: WAD },
    streaks: { [wallet(0)]: 0 },
  };
  for (let id = 1; id <= 4; id++) {
    const current = {
      ...round,
      id,
      startBlock: id * 2,
      endBlock: id * 2 + 1,
      startTs: id * 2,
      endTs: id * 2 + 1,
      pot: 100n,
    };
    f.sql
      .prepare("INSERT INTO rounds VALUES(?,?,?,?,?,'PENDING',?,?,?)")
      .run(
        id,
        current.startBlock,
        current.endBlock,
        current.threshold.toString(),
        current.winner,
        current.pot.toString(),
        current.reason,
        json(current),
      );
    f.sql
      .prepare(
        "INSERT INTO settlement_jobs(round,prices,gasWei,walletCursor) VALUES(?,?,?,?)",
      )
      .run(id, json({ catalana: WAD }), "100", wallet(0));
    f.sql
      .prepare("INSERT INTO round_weights VALUES(?,?,?,?,?)")
      .run(id, wallet(0), WAD.toString(), WAD.toString(), 0);
    const expected = buildManifest(
      current,
      computed,
      previous,
      100n,
      1,
      tokens,
    );
    await finalizePending(f.env, rpc, tokens, [{ round: id } as HatchRecord]);
    await flushPublications(f.env);
    const actual = JSON.parse(f.objects.get("payouts/" + id + ".json")!);
    compareManifest(expected, actual);
    assert.deepEqual(actual.carry, expected.carry);
    previous = expected.carry.map((row) => ({
      ...row,
      amountWei: BigInt(row.amountWei),
    }));
  }
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM manifests").get()!.n, 4);
  f.sql.close();
});
