import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./fixture";
import { maintainFeedSources } from "../src/feed-sources";
import {
  publicStateSchema,
  emptyState,
} from "../../../packages/core/src/state";

const tokens = [{ id: "egg" }, { id: "chick" }, { id: "catalana" }];
type Fixture = ReturnType<typeof fixture>;
function setup() {
  const f = fixture();
  f.sql.prepare("INSERT INTO meta(key,value) VALUES('indexStart','1')").run();
  return f;
}
function swap(
  f: Fixture,
  id: string,
  token: string,
  volume: bigint,
  fee: bigint | null,
  verified = 1,
  kind = "trade",
) {
  f.sql
    .prepare(
      "INSERT INTO swaps(id,token,family,block,logIndex,ts,volume,side,wallet,tx,creatorFeeWei,feeVerified,kind) VALUES(?,?,NULL,1,0,100,?,'buy','0x1111111111111111111111111111111111111111',?,?,?,?)",
    )
    .run(
      id,
      token,
      volume.toString(),
      id,
      fee?.toString() ?? null,
      verified,
      kind,
    );
}
function byToken(result: Awaited<ReturnType<typeof maintainFeedSources>>) {
  return Object.fromEntries(
    result.sources.totals.map((row) => [row.token, row]),
  );
}

test("EGG and CHICK activity is visible before family competition, including separate fee credits", async () => {
  const f = setup();
  try {
    swap(f, "egg-one", "egg", 120n, 12n);
    let result = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(byToken(result).egg, {
      token: "egg",
      volumeWei: "120",
      creatorFeeWei: "12",
    });
    assert.deepEqual(byToken(result).chick, {
      token: "chick",
      volumeWei: "0",
      creatorFeeWei: "0",
    });
    assert.equal(result.sources.ready, true);
    assert.equal(result.sources.fromBlock, 1);
    assert.equal(result.sources.throughBlock, 10);
    swap(f, "chick-one", "chick", 80n, 8n);
    swap(f, "realized-fees", "chick", 999999n, 7n, 1, "fee-credit");
    result = await maintainFeedSources(f.env, tokens, 11);
    assert.deepEqual(byToken(result).chick, {
      token: "chick",
      volumeWei: "80",
      creatorFeeWei: "15",
    });
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM rounds").get()!.n, 0);
    assert.equal(
      f.sql.prepare("SELECT value FROM meta WHERE key='active'").get(),
      undefined,
    );
    assert.equal(f.counts.puts, 0);
    const state = publicStateSchema.parse({
      ...emptyState,
      feed: { ...emptyState.feed, sources: result.sources },
    });
    assert.deepEqual(state.feed.sources, result.sources);
  } finally {
    f.sql.close();
  }
});

test("per-token sums stay exact above the integer precision limit and unknown fees stay null", async () => {
  const f = setup();
  const huge = 900719925474099312345678901234567890n;
  try {
    swap(f, "large-one", "egg", huge, huge + 1n);
    swap(f, "large-two", "egg", huge + 3n, huge + 5n);
    swap(f, "unknown", "chick", 9n, 900n, 0);
    swap(f, "missing", "catalana", 8n, null, 1);
    let result = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(byToken(result).egg, {
      token: "egg",
      volumeWei: String(huge * 2n + 3n),
      creatorFeeWei: String(huge * 2n + 6n),
    });
    assert.equal(byToken(result).chick.creatorFeeWei, null);
    assert.equal(byToken(result).catalana.creatorFeeWei, null);
    f.sql
      .prepare(
        "UPDATE swaps SET creatorFeeWei='4',feeVerified=1 WHERE id='unknown'",
      )
      .run();
    f.sql.prepare("DELETE FROM swaps WHERE id='missing'").run();
    result = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(byToken(result).chick, {
      token: "chick",
      volumeWei: "9",
      creatorFeeWei: "4",
    });
    assert.deepEqual(byToken(result).catalana, {
      token: "catalana",
      volumeWei: "0",
      creatorFeeWei: "0",
    });
  } finally {
    f.sql.close();
  }
});

test("existing history is seeded by migration and drains in bounded resumable pages", async () => {
  const f = setup();
  try {
    f.sql.exec(
      "DROP TRIGGER feed_source_insert; DROP TRIGGER feed_source_delete; DROP TRIGGER feed_source_update; DROP TABLE feed_source_changes; DROP TABLE feed_source_totals;",
    );
    const huge = 900719925474099300000000000n;
    let expectedVolume = 0n,
      expectedFees = 0n;
    f.sql.exec("BEGIN");
    for (let i = 0; i < 4001; i++) {
      const volume = huge + BigInt(i),
        fee = huge + BigInt(i * 2);
      swap(f, "old-" + i, "egg", volume, fee);
      expectedVolume += volume;
      expectedFees += fee;
    }
    f.sql.exec("COMMIT");
    f.sql.exec(
      readFileSync("apps/worker/migrations/0010_feed_sources.sql", "utf8"),
    );
    let result;
    for (let page = 0; page < 5; page++) {
      const before = f.counts.sql;
      result = await maintainFeedSources(f.env, tokens, 10);
      assert.ok(
        f.counts.sql - before <= 8,
        "publication work stays bounded independently of total history",
      );
      assert.equal(result.more, page < 4);
      if (page < 4)
        assert.deepEqual(result.sources, {
          ready: false,
          fromBlock: 1,
          throughBlock: null,
          totals: [],
        });
    }
    assert.equal(result!.sources.ready, true);
    assert.deepEqual(byToken(result!).egg, {
      token: "egg",
      volumeWei: String(expectedVolume),
      creatorFeeWei: String(expectedFees),
    });
    const again = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(again.sources, result!.sources);
    assert.equal(
      f.sql.prepare("SELECT COUNT(*) n FROM feed_source_changes").get()!.n,
      0,
    );
  } finally {
    f.sql.close();
  }
});

test("aggregate writes and journal consumption roll back together before retry", async () => {
  const f = setup();
  try {
    swap(f, "one", "egg", 100n, 10n);
    await maintainFeedSources(f.env, tokens, 10);
    swap(f, "two", "egg", 200n, 20n);
    swap(f, "three", "chick", 300n, 30n);
    const journalBefore = f.sql
      .prepare("SELECT COUNT(*) n FROM feed_source_changes")
      .get()!.n;
    f.sql.exec(
      "CREATE TRIGGER interrupt_sources BEFORE UPDATE ON feed_source_totals BEGIN SELECT RAISE(ABORT,'interrupted sources'); END",
    );
    await assert.rejects(
      maintainFeedSources(f.env, tokens, 10),
      /interrupted sources/,
    );
    assert.equal(
      f.sql.prepare("SELECT COUNT(*) n FROM feed_source_changes").get()!.n,
      journalBefore,
    );
    assert.equal(
      f.sql
        .prepare("SELECT volumeWei FROM feed_source_totals WHERE token='egg'")
        .get()!.volumeWei,
      "100",
    );
    f.sql.exec("DROP TRIGGER interrupt_sources");
    const result = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(byToken(result).egg, {
      token: "egg",
      volumeWei: "300",
      creatorFeeWei: "30",
    });
    assert.deepEqual(byToken(result).chick, {
      token: "chick",
      volumeWei: "300",
      creatorFeeWei: "30",
    });
    assert.deepEqual(
      (await maintainFeedSources(f.env, tokens, 10)).sources,
      result.sources,
    );
  } finally {
    f.sql.close();
  }
});

test("updates, deletes and a full reindex cannot duplicate or retain removed contributions", async () => {
  const f = setup();
  try {
    swap(f, "one", "egg", 100n, 10n);
    swap(f, "two", "chick", 20n, 2n);
    await maintainFeedSources(f.env, tokens, 10);
    f.sql
      .prepare(
        "UPDATE swaps SET token='chick',volume='40',creatorFeeWei='4' WHERE id='one'",
      )
      .run();
    f.sql.prepare("DELETE FROM swaps WHERE id='two'").run();
    let result = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(byToken(result).egg, {
      token: "egg",
      volumeWei: "0",
      creatorFeeWei: "0",
    });
    assert.deepEqual(byToken(result).chick, {
      token: "chick",
      volumeWei: "40",
      creatorFeeWei: "4",
    });
    f.sql.exec("DELETE FROM swaps");
    swap(f, "one", "egg", 70n, 7n);
    result = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(byToken(result).egg, {
      token: "egg",
      volumeWei: "70",
      creatorFeeWei: "7",
    });
    assert.deepEqual(byToken(result).chick, {
      token: "chick",
      volumeWei: "0",
      creatorFeeWei: "0",
    });
    f.sql.exec(
      "BEGIN; DELETE FROM swaps; DELETE FROM feed_source_changes; DELETE FROM feed_source_totals; COMMIT",
    );
    swap(f, "one", "egg", 70n, 7n);
    assert.deepEqual(
      (await maintainFeedSources(f.env, tokens, 10)).sources,
      result.sources,
    );
  } finally {
    f.sql.close();
  }
});

test("staged blocks are not presented as a confirmed source snapshot and malformed amounts fail closed", async () => {
  const f = setup();
  try {
    swap(f, "one", "egg", 100n, 10n);
    f.sql
      .prepare("INSERT INTO meta(key,value) VALUES('stagedRange','{}')")
      .run();
    let result = await maintainFeedSources(f.env, tokens, 10);
    assert.deepEqual(result.sources, {
      ready: false,
      fromBlock: 1,
      throughBlock: null,
      totals: [],
    });
    f.sql.prepare("DELETE FROM meta WHERE key='stagedRange'").run();
    result = await maintainFeedSources(f.env, tokens, 10);
    assert.equal(result.sources.ready, true);
    f.sql.prepare("UPDATE swaps SET creatorFeeWei='-1' WHERE id='one'").run();
    await assert.rejects(
      maintainFeedSources(f.env, tokens, 10),
      /Invalid feed source amount/,
    );
    assert.equal(
      f.sql
        .prepare(
          "SELECT creatorFeeWei FROM feed_source_totals WHERE token='egg'",
        )
        .get()!.creatorFeeWei,
      "10",
    );
    assert.equal(
      f.sql.prepare("SELECT COUNT(*) n FROM feed_source_changes").get()!.n,
      2,
    );
  } finally {
    f.sql.close();
  }
});
