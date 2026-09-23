import test from "node:test";
import assert from "node:assert/strict";
import { payoutBatches } from "../../packages/core/src/batches";
import {
  settleBatch,
  outstandingPrincipal,
  type BatchActions,
  type BatchJournal,
} from "../payout-run";
import { requireSettlementExecutor } from "../execution";
import type { Address, Hex } from "viem";
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const tx = ("0x" + "1".repeat(64)) as Hex;
const batch = payoutBatches([{ wallet, amountWei: 70n }])[0];
function harness() {
  let journal: BatchJournal | null = null,
    sends = 0,
    reports = 0,
    verifies = 0;
  const actions: BatchActions = {
    async read() {
      return journal && { ...journal };
    },
    async write(value, exclusive) {
      if (exclusive && journal) throw Error("exists");
      journal = { ...value };
    },
    async prepare() {
      return { nonce: 7, preparedBlock: 100 };
    },
    async submit() {
      sends++;
      return tx;
    },
    async recover() {
      return sends ? tx : null;
    },
    async verify(hash) {
      assert.equal(hash, tx);
      verifies++;
      return { tx, gasWei: 2n };
    },
    async report() {
      reports++;
    },
  };
  return { actions, state: () => ({ journal, sends, reports, verifies }) };
}
test("reported batches are verified and reported again without another payment", async () => {
  const h = harness();
  await settleBatch("manifest", batch, h.actions);
  await settleBatch("manifest", batch, h.actions);
  assert.equal(h.state().sends, 1);
  assert.equal(h.state().verifies, 2);
  assert.equal(h.state().reports, 2);
  assert.equal(h.state().journal?.status, "reported");
});
test("a report failure resumes from the confirmed receipt", async () => {
  const h = harness();
  const report = h.actions.report;
  h.actions.report = async () => {
    throw Error("offline");
  };
  await assert.rejects(settleBatch("manifest", batch, h.actions), /offline/);
  assert.equal(h.state().journal?.status, "confirmed");
  h.actions.report = report;
  await settleBatch("manifest", batch, h.actions);
  assert.equal(h.state().sends, 1);
});
test("crash after broadcast recovers by reserved nonce without resending", async () => {
  const h = harness();
  const write = h.actions.write;
  h.actions.write = async (value, exclusive) => {
    if (value.status === "submitted") throw Error("disk unavailable");
    return write(value, exclusive);
  };
  await assert.rejects(
    settleBatch("manifest", batch, h.actions),
    /disk unavailable/,
  );
  assert.equal(h.state().journal?.status, "prepared");
  h.actions.write = write;
  await settleBatch("manifest", batch, h.actions);
  assert.equal(h.state().sends, 1);
});
test("unknown submission and mismatched journals fail closed", async () => {
  const h = harness();
  h.actions.submit = async () => {
    throw Error("submission uncertain");
  };
  await assert.rejects(
    settleBatch("manifest", batch, h.actions),
    /submission uncertain/,
  );
  await assert.rejects(
    settleBatch("manifest", batch, h.actions),
    /no new payment sent/,
  );
  await assert.rejects(
    settleBatch("different", batch, h.actions),
    /does not match/,
  );
  assert.equal(h.state().sends, 0);
});
test("receipt verification failure never permits a replacement payment", async () => {
  const h = harness();
  h.actions.verify = async () => {
    throw Error("wrong receipt");
  };
  await assert.rejects(
    settleBatch("manifest", batch, h.actions),
    /wrong receipt/,
  );
  await assert.rejects(
    settleBatch("manifest", batch, h.actions),
    /wrong receipt/,
  );
  assert.equal(h.state().sends, 1);
  assert.equal(h.state().reports, 0);
});
test("completed cook and confirmed batches are removed from unpaid principal", () => {
  assert.equal(outstandingPrincipal([batch], new Set(), 30n, false), 100n);
  assert.equal(outstandingPrincipal([batch], new Set(), 30n, true), 70n);
  assert.equal(
    outstandingPrincipal([batch], new Set([batch.hash]), 30n, true),
    0n,
  );
  assert.throws(requireSettlementExecutor, /Rabby/);
});
