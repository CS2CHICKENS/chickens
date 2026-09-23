import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture";
import { consumeWork, type WorkMessage } from "../src/work-queue";
import { warnWorkFailure, workerRpc } from "../src/diagnostics";

test("background diagnostics redact raw errors and preserve queue retries", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  const f = fixture();
  f.sql
    .prepare("INSERT INTO work_jobs(kind,token,sentAt) VALUES(?,?,?)")
    .run("fees", "work-token", 1);
  let acknowledgements = 0;
  const retries: number[] = [];
  const privateValue = "fixture-private-wallet-or-credential";
  const failure = new Error(`D1_ERROR: ${privateValue}`);
  failure.stack = `Sensitive trace ${privateValue}`;
  const batch = {
    messages: [
      {
        body: { kind: "fees", token: "work-token" },
        ack: () => {
          acknowledgements++;
        },
        retry: (options: { delaySeconds: number }) => {
          retries.push(options.delaySeconds);
        },
      },
    ],
  } as unknown as MessageBatch<WorkMessage>;
  try {
    await consumeWork(batch, f.env, async () => {
      throw failure;
    });
    assert.deepEqual(warnings, [
      ["background_failure", { phase: "fees", category: "d1" }],
    ]);
    assert.equal(JSON.stringify(warnings).includes(privateValue), false);
    assert.equal(acknowledgements, 0);
    assert.deepEqual(retries, [30]);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM work_jobs").get()!.n, 1);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM alerts").get()!.n, 1);
    warnWorkFailure(privateValue, new Error(privateValue));
    assert.deepEqual(warnings.at(-1), [
      "background_failure",
      { phase: "other", category: "unknown" },
    ]);
  } finally {
    f.sql.close();
  }
});

test("the Worker RPC wrapper logs only sanitized provider failures", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  const privateValue = "fixture-private-rpc-credential";
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: 35,
            message: `ranges over 10000 blocks are not supported on free plan ${privateValue}`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  await assert.rejects(
    workerRpc(`https://rpc.example.invalid/${privateValue}`).getLogs({
      fromBlock: 1n,
      toBlock: 100n,
    }),
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "rpc_failure");
  const failure = warnings[0][1] as Record<string, unknown>;
  assert.equal(failure.category, "range_limit");
  assert.equal(failure.rpcCode, 35);
  assert.equal(failure.method, "eth_getLogs");
  assert.equal(failure.provider, 1);
  assert.equal(JSON.stringify(warnings).includes(privateValue), false);
  assert.ok(
    Object.keys(failure).every((key) =>
      ["category", "rpcCode", "httpStatus", "method", "provider"].includes(key),
    ),
  );
});

test("a broken logger cannot prevent the durable alert or queue retry", async (t) => {
  t.mock.method(console, "warn", () => {
    throw new Error("fixture logger failure");
  });
  const f = fixture();
  f.sql
    .prepare("INSERT INTO work_jobs(kind,token,sentAt) VALUES(?,?,?)")
    .run("fees", "work-token", 1);
  let acknowledgements = 0;
  const retries: number[] = [];
  const batch = {
    messages: [
      {
        body: { kind: "fees", token: "work-token" },
        ack: () => {
          acknowledgements++;
        },
        retry: (options: { delaySeconds: number }) => {
          retries.push(options.delaySeconds);
        },
      },
    ],
  } as unknown as MessageBatch<WorkMessage>;
  try {
    await consumeWork(batch, f.env, async () => {
      throw new Error("D1_ERROR: fixture operation failure");
    });
    assert.equal(acknowledgements, 0);
    assert.deepEqual(retries, [30]);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM work_jobs").get()!.n, 1);
    assert.equal(
      f.sql.prepare("SELECT COUNT(*) n FROM alerts WHERE id='work-fees'").get()!
        .n,
      1,
    );
    assert.doesNotThrow(() =>
      warnWorkFailure("tick", new Error("fixture operation failure")),
    );
  } finally {
    f.sql.close();
  }
});
