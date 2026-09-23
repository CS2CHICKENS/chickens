import test from "node:test";
import assert from "node:assert/strict";
import { settlementGasReference } from "../src/gas";

test("payout gas reference is deterministic from the end block", () => {
  assert.equal(settlementGasReference(1000000000n), 80040000000000n);
  assert.equal(settlementGasReference(0n), 40000000000n);
  assert.throws(() => settlementGasReference(null));
  assert.throws(() => settlementGasReference(-1n));
});
