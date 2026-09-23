import test from "node:test";
import assert from "node:assert/strict";
import {
  config,
  json,
  roundStartBlock,
  WAD,
  excludedAddresses,
  type BalanceEvent,
  type Swap,
} from "../../../packages/core/src/index";
import {
  derive,
  weights,
  buildManifest,
} from "../../../packages/core/src/engine";
import { settlementGasReference } from "../../../packages/core/src/gas";
import { acceptRoundRules, rulesFingerprint } from "../src/round-rules";
import { meta, putMeta } from "../src/storage";
import { reviveActive, reviveRound, publish } from "../src/publication";
import { tick, storedTokens, storedHatches } from "../src/index";
import { finalizePending } from "../src/finalize";
import { loadManifest } from "../src/manifests";
import { handleAdmin } from "../src/admin";
import { maintainFeedSources } from "../src/feed-sources";
import type { Rpc } from "../src/indexer";
import type { PublicState } from "../../../packages/core/src/state";
import { fixture, mockRpc, curve, holder, hash } from "./fixture";

const start = roundStartBlock();
const reserved = 9007199254740993123456789n;
type Fixture = ReturnType<typeof fixture>;

async function legacyWaiting() {
  const f = fixture();
  await putMeta(f.env.DB, "rulesFingerprint", rulesFingerprint(true));
  await putMeta(f.env.DB, "cursor", String(start + 10));
  await putMeta(f.env.DB, "indexStart", String(start));
  await putMeta(f.env.DB, "creatorFeesWei", reserved.toString());
  await putMeta(f.env.DB, "feesVerified", "true");
  await putMeta(
    f.env.DB,
    "active",
    json({
      id: 1,
      startBlock: start,
      startTs: 0,
      threshold: 100n * WAD,
      tokens: {},
      families: {},
      creatorFeeWei: 0n,
      growthSteps: 0,
    }),
  );
  return f;
}

function insertSwap(f: Fixture, family: string | null, verified = 1) {
  f.sql
    .prepare(
      "INSERT INTO swaps(id,token,family,block,logIndex,ts,volume,side,wallet,tx,creatorFeeWei,feeVerified,kind) VALUES('trade','egg',?,?,0,10,'1','buy',?,'trade','1',?,'trade')",
    )
    .run(family, start + 1, holder, verified);
}

async function adopt(f: Fixture, hasRounds = false, indexStart = start) {
  return acceptRoundRules(
    f.env,
    reviveActive(await meta(f.env.DB, "active")),
    hasRounds,
    start + 10,
    indexStart,
  );
}

test("a waiting legacy round adopts verified opening fees exactly once without moving the index cursor", async () => {
  const f = await legacyWaiting();
  try {
    insertSwap(f, null);
    let result = await adopt(f);
    assert.equal(result.accepted, true);
    assert.equal(result.active!.creatorFeeWei, reserved);
    assert.equal(result.active!.preStartCreatorFeeWei, reserved);
    assert.equal(result.active!.feeStartBlock, start);
    assert.equal(result.active!.startTs, 0);
    assert.deepEqual(result.active!.tokens, {});
    assert.deepEqual(result.active!.families, {});
    assert.equal(await meta(f.env.DB, "cursor"), String(start + 10));
    assert.equal(await meta(f.env.DB, "creatorFeesWei"), reserved.toString());
    assert.equal(await meta(f.env.DB, "rulesFingerprint"), rulesFingerprint());
    const committed = await meta(f.env.DB, "active");
    await putMeta(f.env.DB, "creatorFeesWei", String(reserved + 77n));
    result = await adopt(f);
    assert.equal(result.accepted, true);
    assert.equal(result.active!.creatorFeeWei, reserved);
    assert.equal(await meta(f.env.DB, "active"), committed);
    assert.equal(await meta(f.env.DB, "cursor"), String(start + 10));
  } finally {
    f.sql.close();
  }
});

test("an interrupted legacy adoption rolls back both fees and fingerprint before retry", async () => {
  const f = await legacyWaiting();
  try {
    const original = await meta(f.env.DB, "active");
    f.sql.exec(
      "CREATE TRIGGER interrupt_adoption BEFORE UPDATE ON meta WHEN NEW.key='rulesFingerprint' BEGIN SELECT RAISE(ABORT,'interrupted adoption'); END",
    );
    await assert.rejects(adopt(f), /interrupted adoption/);
    assert.equal(await meta(f.env.DB, "active"), original);
    assert.equal(
      await meta(f.env.DB, "rulesFingerprint"),
      rulesFingerprint(true),
    );
    assert.equal(await meta(f.env.DB, "cursor"), String(start + 10));
    f.sql.exec("DROP TRIGGER interrupt_adoption");
    assert.equal((await adopt(f)).active!.creatorFeeWei, reserved);
    assert.equal((await adopt(f)).active!.creatorFeeWei, reserved);
  } finally {
    f.sql.close();
  }
});

const blockedHistory = [
  [
    "round",
    "INSERT INTO rounds VALUES(1,1,2,'100','catalana','PENDING','1','threshold','{}')",
  ],
  ["manifest", "INSERT INTO manifests VALUES(1,'hash','{}')"],
  [
    "payout",
    "INSERT INTO payouts VALUES(1,'wallet','family','1','PREPARED',NULL)",
  ],
  ["carryover", "INSERT INTO carryover VALUES('wallet',1,'family','1')"],
  ["split release", "INSERT INTO split_releases VALUES('release',1,'1','1')"],
  [
    "payout receipt",
    "INSERT INTO payout_receipts VALUES('tx',1,'batch',1,'1')",
  ],
  ["cook", "INSERT INTO cooks VALUES(1,'egg','1','1','tx')"],
];
test("adoption does not depend on a seven-term compound SELECT", async () => {
  for (const [label, insert] of [["empty", ""], ...blockedHistory]) {
    const f = await legacyWaiting();
    const originalPrepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = (query: string) => {
      if ((query.match(/\b(?:UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0) >= 6)
        throw Error(
          "too many terms in compound SELECT: SQLITE_ERROR [code7500]",
        );
      return originalPrepare(query);
    };
    try {
      if (insert) f.sql.exec(insert);
      const result = await adopt(f);
      assert.equal(result.accepted, !insert, label);
      assert.equal(await meta(f.env.DB, "cursor"), String(start + 10));
      assert.equal(
        await meta(f.env.DB, "rulesFingerprint"),
        rulesFingerprint(!!insert),
        label,
      );
    } finally {
      f.sql.close();
    }
  }
});

for (const [label, query] of blockedHistory) {
  test("legacy adoption refuses existing " + label + " history", async () => {
    const f = await legacyWaiting();
    try {
      const original = await meta(f.env.DB, "active");
      f.sql.exec(query);
      assert.equal((await adopt(f)).accepted, false);
      assert.equal(await meta(f.env.DB, "active"), original);
      assert.equal(
        await meta(f.env.DB, "rulesFingerprint"),
        rulesFingerprint(true),
      );
      assert.equal(await meta(f.env.DB, "cursor"), String(start + 10));
    } finally {
      f.sql.close();
    }
  });
}

test("adoption refuses an opened family round, unverified totals and unrelated rule changes", async () => {
  const cases: Array<[string, (f: Fixture) => Promise<void> | void]> = [
    ["first family trade", (f) => insertSwap(f, "catalana")],
    [
      "opening timestamp",
      async (f) => {
        const active = reviveActive(await meta(f.env.DB, "active"))!;
        await putMeta(f.env.DB, "active", json({ ...active, startTs: 1 }));
      },
    ],
    [
      "later round",
      async (f) => {
        const active = reviveActive(await meta(f.env.DB, "active"))!;
        await putMeta(f.env.DB, "active", json({ ...active, id: 2 }));
      },
    ],
    ["unverified fees", (f) => putMeta(f.env.DB, "feesVerified", "false")],
    [
      "missing fees",
      (f) => {
        f.sql.prepare("DELETE FROM meta WHERE key='creatorFeesWei'").run();
      },
    ],
    ["malformed fees", (f) => putMeta(f.env.DB, "creatorFeesWei", "-1")],
    [
      "unrelated fingerprint",
      (f) => putMeta(f.env.DB, "rulesFingerprint", hash(1)),
    ],
  ];
  for (const [label, prepare] of cases) {
    const f = await legacyWaiting();
    try {
      await prepare(f);
      const original = await meta(f.env.DB, "active");
      assert.equal((await adopt(f)).accepted, false, label);
      assert.equal(await meta(f.env.DB, "active"), original, label);
      assert.equal(await meta(f.env.DB, "cursor"), String(start + 10), label);
    } finally {
      f.sql.close();
    }
  }
  const f = await legacyWaiting();
  try {
    assert.equal((await adopt(f, true)).accepted, false);
    assert.equal((await adopt(f, false, start + 1)).accepted, false);
  } finally {
    f.sql.close();
  }
});

test("the indexer pauses on a rule conflict without skipping unseen blocks", async () => {
  const f = await legacyWaiting();
  try {
    await putMeta(f.env.DB, "rulesFingerprint", hash(1));
    const before = await meta(f.env.DB, "active");
    await tick(f.env, { rpc: mockRpc(start + 100).rpc, queued: true });
    assert.equal(await meta(f.env.DB, "paused"), "true");
    assert.equal(await meta(f.env.DB, "cursor"), String(start + 10));
    assert.equal(await meta(f.env.DB, "active"), before);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM swaps").get()!.n, 0);
    assert.ok(
      f.sql.prepare("SELECT id FROM alerts WHERE id='rules-changed'").get(),
    );
  } finally {
    f.sql.close();
  }
});

test("reserved EGG and CHICK fees survive upgrade and match the all-history settlement and public sources", async () => {
  const f = fixture();
  f.env.WORK = { send: async () => {} } as unknown as NonNullable<
    typeof f.env.WORK
  >;
  const launches = config.tokenLaunchBlocks;
  const firstFamily = launches.catalana + 1;
  const end = firstFamily + 20;
  const fee = (17n * WAD) / 1000n;
  const trades = [
    { token: "egg", block: start + 1, volume: 1000n * WAD },
    { token: "chick", block: launches.chick + 1, volume: 2000n * WAD },
    { token: "catalana", block: firstFamily, volume: 99n * WAD },
    { token: "catalana", block: end, volume: WAD },
  ];
  const original = mockRpc(end).rpc;
  const rpc = {
    ...original,
    getContractEvents: async (params: {
      address: string;
      eventName?: string;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      const token = config.tokens.find(
        (entry) =>
          curve(entry.address).toLowerCase() === params.address.toLowerCase(),
      );
      if (!token || params.eventName)
        return original.getContractEvents(params as never);
      return trades
        .filter(
          (entry) =>
            entry.token === token.id &&
            BigInt(entry.block) >= params.fromBlock &&
            BigInt(entry.block) <= params.toBlock,
        )
        .map((entry) => ({
          eventName: "CurveBuy",
          args: {
            buyer: holder,
            recipient: holder,
            quoteIn: entry.volume,
            tokensOut: WAD,
            fee: WAD / 100n,
            tax: WAD / 100n,
          },
          blockNumber: BigInt(entry.block),
          logIndex: 1,
          transactionHash: hash(entry.block),
        }));
    },
  } as unknown as Rpc;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ coins: {} });
  try {
    await tick(f.env, { rpc, maxBlocks: firstFamily - start, queued: true });
    assert.equal(await meta(f.env.DB, "cursor"), String(firstFamily - 1));
    assert.equal(await meta(f.env.DB, "creatorFeesWei"), String(2n * fee));
    assert.equal(reviveActive(await meta(f.env.DB, "active"))!.startTs, 0);
    const waitingBlock = await rpc.getBlock({
      blockNumber: BigInt(firstFamily - 1),
    });
    const waiting = {
      number: firstFamily - 1,
      ts: Number(waitingBlock.timestamp),
      hash: waitingBlock.hash!,
    };
    await publish(
      f.env,
      rpc,
      await storedTokens(f.env),
      [],
      [],
      reviveActive(await meta(f.env.DB, "active")),
      waiting,
      waiting,
      { wallets: false },
    );
    const waitingState: PublicState = JSON.parse(f.objects.get("state.json")!);
    assert.equal(waitingState.mode, "monitoring");
    assert.equal(waitingState.feed.preStartCreatorFeeWei, String(2n * fee));
    assert.equal(waitingState.round.potWei, String(fee));
    assert.deepEqual(waitingState.round.volumeByFamily, {});
    assert.equal(
      waitingState.feed.sources!.totals.find((row) => row.token === "egg")!
        .volumeWei,
      String(1000n * WAD),
    );
    const legacy = JSON.parse((await meta(f.env.DB, "active"))!);
    delete legacy.feeStartBlock;
    delete legacy.preStartCreatorFeeWei;
    legacy.creatorFeeWei = "0";
    await putMeta(f.env.DB, "active", json(legacy));
    await putMeta(f.env.DB, "rulesFingerprint", rulesFingerprint(true));
    await tick(f.env, { rpc, maxBlocks: 100, queued: true });
    assert.equal(await meta(f.env.DB, "cursor"), String(end));
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM swaps").get()!.n, 4);
    const tokens = await storedTokens(f.env);
    const blockNumbers = [
      ...new Set([start, ...trades.map((entry) => entry.block)]),
    ];
    const blocks = await Promise.all(
      blockNumbers.map(async (number) => {
        const block = await rpc.getBlock({ blockNumber: BigInt(number) });
        return { number, ts: Number(block.timestamp), hash: block.hash! };
      }),
    );
    const swaps: Swap[] = trades.map((entry) => ({
      token: entry.token,
      family: entry.token === "catalana" ? "catalana" : undefined,
      block: entry.block,
      logIndex: 1,
      ts: blocks.find((block) => block.number === entry.block)!.ts,
      volume: entry.volume,
      side: "buy",
      wallet: holder,
      tx: hash(entry.block),
      creatorFeeWei: fee,
      feeVerified: true,
      kind: "trade",
    }));
    const expected = derive(swaps, blocks, start, 100n * WAD, false, tokens);
    const round = reviveRound(
      String(f.sql.prepare("SELECT data FROM rounds WHERE id=1").get()!.data),
    );
    assert.deepEqual(round, expected.rounds[0]);
    assert.equal(round.startBlock, firstFamily);
    assert.equal(round.feeStartBlock, start);
    assert.equal(round.creatorFeeWei, 4n * fee);
    assert.equal(round.preStartCreatorFeeWei, 2n * fee);
    assert.equal(round.pot, 2n * fee);
    assert.deepEqual(round.familyVolumes, { catalana: 100n * WAD });
    assert.deepEqual(round.volumes, { catalana: 100n * WAD });
    const balances: BalanceEvent[] = await Promise.all(
      tokens
        .filter((token) => token.launchBlock <= end)
        .map(async (token) => ({
          token: token.id,
          wallet: holder,
          block: token.launchBlock,
          logIndex: 0,
          ts: Number(
            (await rpc.getBlock({ blockNumber: BigInt(token.launchBlock) }))
              .timestamp,
          ),
          delta: 100n * WAD,
        })),
    );
    const computed = weights(
      round,
      balances,
      tokens.filter((token) => token.launchBlock <= end),
      { catalana: 4_000_000_000n },
      excludedAddresses(tokens),
      {},
    );
    const expectedManifest = buildManifest(
      round,
      computed,
      [],
      settlementGasReference(1000n),
      1,
      tokens.filter((token) => token.launchBlock <= end),
    );
    const hatches = await storedHatches(f.env);
    f.sql.prepare("UPDATE swaps SET feeVerified=0 WHERE token='egg'").run();
    await assert.rejects(
      finalizePending(f.env, rpc, tokens, hatches),
      /fees have not been independently verified/,
    );
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM manifests").get()!.n, 0);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM payouts").get()!.n, 0);
    f.sql.prepare("UPDATE swaps SET feeVerified=1 WHERE token='egg'").run();
    await finalizePending(f.env, rpc, tokens, hatches);
    assert.deepEqual(
      await loadManifest(f.env.DB, 1),
      JSON.parse(json(expectedManifest)),
    );
    assert.equal(
      f.sql.prepare("SELECT status FROM rounds WHERE id=1").get()!.status,
      "PUBLISHED",
    );
    const indexed = blocks.find((block) => block.number === end)!;
    await publish(
      f.env,
      rpc,
      tokens,
      [round],
      hatches,
      reviveActive(await meta(f.env.DB, "active")),
      indexed,
      indexed,
      { wallets: false },
    );
    const state: PublicState = JSON.parse(f.objects.get("state.json")!);
    assert.equal(state.feed.sources!.ready, true);
    assert.equal(state.feed.sources!.throughBlock, end);
    const sources = Object.fromEntries(
      state.feed.sources!.totals.map((row) => [row.token, row]),
    );
    assert.deepEqual(sources.egg, {
      token: "egg",
      volumeWei: String(1000n * WAD),
      creatorFeeWei: String(fee),
    });
    assert.deepEqual(sources.chick, {
      token: "chick",
      volumeWei: String(2000n * WAD),
      creatorFeeWei: String(fee),
    });
    assert.deepEqual(sources.catalana, {
      token: "catalana",
      volumeWei: String(100n * WAD),
      creatorFeeWei: String(2n * fee),
    });
    assert.equal(state.feed.generatedWei, String(4n * fee));
    assert.equal(state.feed.preStartCreatorFeeWei, null);
    await tick(f.env, { rpc, maxBlocks: 100, queued: true });
    assert.equal(await meta(f.env.DB, "creatorFeesWei"), String(4n * fee));
    assert.deepEqual(
      await loadManifest(f.env.DB, 1),
      JSON.parse(json(expectedManifest)),
    );
  } finally {
    globalThis.fetch = oldFetch;
    f.sql.close();
  }
});

test("reindex clears both feed aggregates and deletion journals before replay", async () => {
  const f = await legacyWaiting();
  try {
    insertSwap(f, null);
    await maintainFeedSources(f.env, [{ id: "egg" }], start + 10);
    await putMeta(f.env.DB, "paused", "true");
    const response = await handleAdmin(
      new Request("https://engine.invalid/admin/reindex", {
        method: "POST",
        headers: { "x-admin-secret": f.env.ADMIN_SECRET! },
        body: json({ action: "reindex", block: start + 5 }),
      }),
      f.env,
    );
    assert.equal(response.status, 200);
    for (const table of ["swaps", "feed_source_changes", "feed_source_totals"])
      assert.equal(
        f.sql.prepare("SELECT COUNT(*) n FROM " + table).get()!.n,
        0,
        table,
      );
    assert.equal(await meta(f.env.DB, "cursor"), String(start - 1));
    assert.equal(await meta(f.env.DB, "rulesFingerprint"), undefined);
    assert.equal(await meta(f.env.DB, "active"), undefined);
    insertSwap(f, null);
    const result = await maintainFeedSources(
      f.env,
      [{ id: "egg" }],
      start + 10,
    );
    assert.deepEqual(result.sources.totals, [
      { token: "egg", volumeWei: "1", creatorFeeWei: "1" },
    ]);
  } finally {
    f.sql.close();
  }
});
