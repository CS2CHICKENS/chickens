import test from "node:test";
import assert from "node:assert/strict";
import { fixture, mockRpc } from "./fixture";
import {
  scheduleWork,
  consumeWork,
  type WorkMessage,
  type WorkKind,
} from "../src/work-queue";
import { LedgerBusy, withLedgerLease } from "../src/lease";
import { executeBackground } from "../src/background";
import { meta, putMeta } from "../src/storage";

function queueFixture() {
  const f = fixture(),
    sent: WorkMessage[] = [];
  let beforeSend: ((message: WorkMessage) => Promise<void>) | undefined;
  let afterSend: ((message: WorkMessage) => Promise<void>) | undefined;
  f.env.WORK = {
    send: async (message: WorkMessage) => {
      await beforeSend?.(message);
      sent.push({ ...message });
      await afterSend?.(message);
    },
  } as unknown as Queue<WorkMessage>;
  return {
    ...f,
    sent,
    failBefore: (callback?: typeof beforeSend) => {
      beforeSend = callback;
    },
    failAfter: (callback?: typeof afterSend) => {
      afterSend = callback;
    },
  };
}
function batch(body: unknown) {
  const outcome = { acknowledgements: 0, retries: [] as number[] };
  const messages = [
    {
      id: "message",
      timestamp: new Date(),
      attempts: 1,
      body,
      ack: () => {
        outcome.acknowledgements++;
      },
      retry: (options?: { delaySeconds?: number }) => {
        outcome.retries.push(options?.delaySeconds ?? 0);
      },
    },
  ];
  return {
    outcome,
    batch: { queue: "work", messages } as unknown as MessageBatch<WorkMessage>,
  };
}

test("work scheduling deduplicates active kinds and recovers failed or stale dispatch with the same token", async () => {
  const f = queueFixture();
  await Promise.all([
    scheduleWork(f.env, "settlement"),
    scheduleWork(f.env, "settlement"),
  ]);
  assert.equal(f.sent.length, 1);
  const token = f.sent[0].token;
  await scheduleWork(f.env, "settlement");
  assert.equal(f.sent.length, 1);
  f.sql.prepare("UPDATE work_jobs SET sentAt=0 WHERE kind='settlement'").run();
  await scheduleWork(f.env, "settlement");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].token, token);
  f.failBefore(async () => {
    throw Error("dispatch unavailable");
  });
  await assert.rejects(
    scheduleWork(f.env, "publication"),
    /dispatch unavailable/,
  );
  const pending = f.sql
    .prepare("SELECT token,sentAt FROM work_jobs WHERE kind='publication'")
    .get()!;
  assert.equal(pending.sentAt, 0);
  f.failBefore();
  await scheduleWork(f.env, "publication");
  assert.equal(f.sent.at(-1)!.token, pending.token);
  f.sql.close();
});

test("stale and malformed deliveries cannot execute or remove newer work", async () => {
  const f = queueFixture();
  await scheduleWork(f.env, "index");
  const current = f.sent[0];
  let executions = 0;
  for (const body of [
    null,
    { kind: "unknown", token: current.token },
    { kind: "index", token: 1 },
    { kind: "index", token: "old" },
  ]) {
    const delivery = batch(body);
    await consumeWork(delivery.batch, f.env, async () => {
      executions++;
      return false;
    });
    assert.equal(delivery.outcome.acknowledgements, 1);
    assert.deepEqual(delivery.outcome.retries, []);
  }
  assert.equal(executions, 0);
  assert.equal(
    f.sql.prepare("SELECT token FROM work_jobs WHERE kind='index'").get()!
      .token,
    current.token,
  );
  const delivery = batch(current);
  await consumeWork(delivery.batch, f.env, async () => {
    executions++;
    return false;
  });
  assert.equal(executions, 1);
  assert.equal(delivery.outcome.acknowledgements, 1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM work_jobs").get()!.n, 0);
  f.sql.close();
});

test("a crash after continuation dispatch preserves progress and redundant deliveries become harmless", async () => {
  const f = queueFixture();
  await scheduleWork(f.env, "settlement");
  const first = f.sent.shift()!;
  await putMeta(f.env.DB, "testProgress", "0");
  const execute = async () => {
    const progress = Number(await meta(f.env.DB, "testProgress"));
    await putMeta(f.env.DB, "testProgress", String(Math.min(2, progress + 1)));
    return progress + 1 < 2;
  };
  f.failAfter(async () => {
    throw Error("dispatch acknowledgement lost");
  });
  const delivery = batch(first);
  await consumeWork(delivery.batch, f.env, execute);
  assert.equal(await meta(f.env.DB, "testProgress"), "1");
  assert.deepEqual(delivery.outcome.retries, [30]);
  assert.equal(delivery.outcome.acknowledgements, 0);
  assert.equal(f.sent.length, 1);
  f.failAfter();
  const continuation = batch(f.sent.shift()!);
  await consumeWork(continuation.batch, f.env, execute);
  assert.equal(await meta(f.env.DB, "testProgress"), "2");
  assert.equal(continuation.outcome.acknowledgements, 1);
  const retried = batch(first);
  let unexpected = 0;
  await consumeWork(retried.batch, f.env, async () => {
    unexpected++;
    return false;
  });
  assert.equal(unexpected, 0);
  assert.equal(retried.outcome.acknowledgements, 1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM work_jobs").get()!.n, 0);
  f.sql.close();
});

test("busy ledgers retry quietly and absent bindings neither schedule nor lose continuations", async () => {
  const f = queueFixture();
  await scheduleWork(f.env, "wallets");
  const message = f.sent.shift()!,
    busy = batch(message);
  await consumeWork(busy.batch, f.env, async () => {
    throw new LedgerBusy();
  });
  assert.deepEqual(busy.outcome.retries, [5]);
  assert.equal(busy.outcome.acknowledgements, 0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM alerts").get()!.n, 0);
  delete f.env.WORK;
  const before = f.counts.sql;
  await scheduleWork(f.env, "index");
  assert.equal(f.counts.sql, before);
  const missing = batch(message);
  await consumeWork(missing.batch, f.env, async () => true);
  assert.deepEqual(missing.outcome.retries, [30]);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM work_jobs").get()!.n, 1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM alerts").get()!.n, 1);
  f.sql.close();
});

test("concurrent checkpoints share renewal and a replaced lease cannot be erased by its former owner", async () => {
  const f = fixture();
  await withLedgerLease(f.env, async (locked) => {
    await assert.rejects(
      withLedgerLease(f.env, async () => true),
      LedgerBusy,
    );
    assert.equal(
      await withLedgerLease(f.env, async () => true, false),
      undefined,
    );
    const before = f.counts.sql;
    await Promise.all([
      locked.checkpoint!(),
      locked.checkpoint!(),
      locked.checkpoint!(),
    ]);
    assert.equal(f.counts.sql - before, 1);
    await putMeta(f.env.DB, "lease", "9999999999");
    await assert.rejects(locked.checkpoint!(), /lease expired or changed/);
  });
  assert.equal(await meta(f.env.DB, "lease"), "9999999999");
  f.sql.close();
});

test("queued indexing, fees, settlement and publication drain independently within D1 budgets", async () => {
  const f = queueFixture(),
    { rpc } = mockRpc();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ coins: {} }));
  const phases = new Map<WorkKind, number>();
  try {
    await scheduleWork(f.env, "index");
    for (let step = 0; f.sent.length && step < 30; step++) {
      const message = f.sent.shift()!,
        delivery = batch(message);
      await consumeWork(delivery.batch, f.env, async (kind) => {
        const before = f.counts.sql;
        const more = await executeBackground(f.env, kind, rpc);
        phases.set(
          kind,
          Math.max(phases.get(kind) ?? 0, f.counts.sql - before),
        );
        return more;
      });
      assert.deepEqual(
        delivery.outcome.retries,
        [],
        "unexpected retry for " + message.kind,
      );
      assert.equal(delivery.outcome.acknowledgements, 1);
    }
    assert.equal(f.sent.length, 0);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM work_jobs").get()!.n, 0);
    for (const kind of [
      "index",
      "fees",
      "settlement",
      "wallets",
      "publication",
    ] as const) {
      assert.ok(phases.has(kind), "missing phase " + kind);
      assert.ok(
        phases.get(kind)! < 1000,
        "D1 query budget exceeded by " + kind,
      );
    }
    const state = JSON.parse(f.objects.get("state.json")!);
    assert.equal(state.mode, "live");
    assert.equal(state.feed.collectedWei, "0");
    assert.equal(state.feed.collection.status, "verified");
    assert.ok([...f.objects.keys()].some((key) => key.startsWith("wallets/")));
    assert.equal(await meta(f.env.DB, "lease"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    f.sql.close();
  }
});
