import test from "node:test";
import assert from "node:assert/strict";
import { HttpRequestError } from "viem";
import { client } from "../src/chain";
import { config } from "../src/index";
import {
  rpcFailure,
  summarizeFailure,
  type RpcFailure,
} from "../src/rpc-failure";

const privateValue = "fixture-private-credential-48956";
const privateUrl = `https://rpc.example.invalid/${privateValue}?token=${privateValue}`;

function assertPrivate(value: unknown) {
  const output = JSON.stringify(value);
  assert.equal(output.includes(privateValue), false);
  assert.equal(output.includes(privateUrl), false);
  for (const field of [
    "stack",
    "params",
    "url",
    "message",
    "details",
    "body",
    "cause",
  ])
    assert.equal(output.includes(`"${field}"`), false);
}

test("nested HTTP details retain RPC range codes without disclosing request data", () => {
  const cause = new HttpRequestError({
    status: 400,
    url: privateUrl,
    body: { params: [privateValue], authorization: privateValue },
    details: JSON.stringify({
      code: 35,
      message: `ranges over 10000 blocks: ${privateValue}`,
    }),
  });
  const error = new Error(`Request failed: ${privateUrl}`, { cause });
  error.stack = `Sensitive trace ${privateValue}`;
  const result = rpcFailure(error, "eth_getLogs", 1);
  assert.deepEqual(result, {
    category: "range_limit",
    httpStatus: 400,
    rpcCode: 35,
    method: "eth_getLogs",
    provider: 1,
  });
  assertPrivate(result);
});

test("background failure categories contain only fixed labels and numeric codes", () => {
  const cases = [
    ["Cannot perform I/O on behalf of a different request", "io_context"],
    ["Query exceeded the configured work budget", "budget"],
    ["Too many subrequests", "budget"],
    ["D1_ERROR: database unavailable", "d1"],
    ["SQLITE_BUSY: retry later", "d1"],
    ["R2 put failed", "r2"],
    ["Indexer lease expired or changed", "lease"],
    ["Timeout waiting for response", "timeout"],
    ["Historical state unavailable", "archive_unavailable"],
    ["fetch failed", "network"],
    ["Unexpected operation failure", "unknown"],
  ] as const;
  for (const [message, category] of cases) {
    const error = new Error("Wrapped failure", {
      cause: new Error(`${message} ${privateUrl}`),
    });
    error.stack = privateValue;
    const result = summarizeFailure(error);
    assert.deepEqual(result, { category });
    assertPrivate(result);
  }
  assert.deepEqual(summarizeFailure({ status: 429, code: 429 }), {
    category: "rate_limit",
    httpStatus: 429,
    rpcCode: 429,
  });
  assert.deepEqual(summarizeFailure({ status: 503 }), {
    category: "http",
    httpStatus: 503,
  });
  assert.deepEqual(summarizeFailure({ status: 403 }), {
    category: "access_denied",
    httpStatus: 403,
  });
  assert.deepEqual(summarizeFailure({ code: -32602 }), {
    category: "rpc",
    rpcCode: -32602,
  });
});

test("untrusted fields, cycles and malformed details cannot escape diagnostic bounds", () => {
  const error: Record<string, unknown> = {
    message: privateValue,
    status: privateValue,
    code: Number.MAX_SAFE_INTEGER,
    details: `{${privateValue}`,
  };
  error.cause = error;
  Object.defineProperty(error, "name", {
    get() {
      throw new Error(privateValue);
    },
  });
  const result = rpcFailure(error, privateValue, privateValue);
  assert.deepEqual(result, {
    category: "unknown",
    method: "other",
    provider: 0,
  });
  assertPrivate(result);
  assert.deepEqual(summarizeFailure(null), { category: "unknown" });
  assert.deepEqual(
    summarizeFailure(
      new Error("Wrapper", {
        cause: {
          details: JSON.stringify({
            error: { code: 35, message: privateValue },
          }),
        },
      }),
    ),
    { category: "range_limit", rpcCode: 35 },
  );
});

test("the first provider failure is observed before a fallback rate limit masks it", async (t) => {
  const failures: RpcFailure[] = [];
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(Array.isArray(body), false);
      if (requests++ === 0) {
        assert.equal(
          new URL(String(input)).hostname,
          new URL(config.rpc[0]).hostname,
        );
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: `missing trie node ${privateUrl}` },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      assert.deepEqual(failures, [
        {
          category: "archive_unavailable",
          rpcCode: -32000,
          method: "eth_getLogs",
          provider: 1,
        },
      ]);
      return new Response(
        JSON.stringify({
          error: { code: 429, message: `Too Many Requests ${privateValue}` },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  await assert.rejects(
    client(undefined, (failure) => failures.push(failure)).getLogs({
      fromBlock: 1n,
      toBlock: 100n,
    }),
  );
  assert.equal(requests, 2);
  assert.equal(failures.length, 2);
  assert.equal(failures[1].category, "rate_limit");
  assert.equal(failures[1].provider, 2);
  assert.equal(failures[1].rpcCode, 429);
  assertPrivate(failures);
});

test("range failures are observed without changing the existing no-fallback decision", async (t) => {
  const failures: RpcFailure[] = [];
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
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
    client(privateUrl, (failure) => failures.push(failure)).getLogs({
      fromBlock: 1n,
      toBlock: 100n,
    }),
  );
  assert.equal(requests, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].category, "range_limit");
  assert.equal(failures[0].rpcCode, 35);
  assert.equal(failures[0].provider, 1);
  assertPrivate(failures);
});

test("a failing observer cannot alter fallback success", async (t) => {
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (requests++ === 0) return new Response("Unavailable", { status: 503 });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const logs = await client(undefined, () => {
    throw new Error(privateValue);
  }).getLogs({ fromBlock: 1n, toBlock: 100n });
  assert.deepEqual(logs, []);
  assert.equal(requests, 2);
});

test(
  "an async observer neither delays fallback nor leaks its rejected promise",
  { timeout: 5000 },
  async (t) => {
    let requests = 0,
      observations = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (requests++ === 0)
          return new Response("Unavailable", { status: 503 });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const logs = await Promise.race([
        client(undefined, async () => {
          observations++;
          await gate;
          throw new Error(privateValue);
        }).getLogs({ fromBlock: 1n, toBlock: 100n }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("RPC waited for its diagnostic observer")),
            2000,
          );
        }),
      ]);
      assert.deepEqual(logs, []);
      assert.equal(requests, 2);
      assert.equal(observations, 1);
    } finally {
      clearTimeout(timer);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  },
);

test("an observer thenable with a throwing getter cannot leak a rejection", async (t) => {
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (requests++ === 0) return new Response("Unavailable", { status: 503 });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  assert.deepEqual(
    await client(undefined, () =>
      Object.defineProperty({}, "then", {
        get() {
          throw new Error(privateValue);
        },
      }),
    ).getLogs({ fromBlock: 1n, toBlock: 100n }),
    [],
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
});
