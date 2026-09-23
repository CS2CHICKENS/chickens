import { test } from "node:test";
import assert from "node:assert/strict";
import { settlementOptions } from "../execution";

test("settlement defaults to verification and requires explicit execution", () => {
  assert.deepEqual(settlementOptions(["--round", "4"]), {
    round: 4,
    dryRun: true,
  });
  assert.equal(settlementOptions(["--round", "4", "--dry-run"]).dryRun, true);
  assert.equal(settlementOptions(["--round", "4", "--execute"]).dryRun, false);
});

test("ambiguous or malformed settlement commands cannot execute", () => {
  for (const args of [
    ["--round", "4", "--execute", "--dry-run"],
    ["--round", "4", "--execute", "--dryrun"],
    ["--round", "4", "--execute=false"],
    ["--execute"],
    ["--round", "0", "--execute"],
    ["--round", "-1", "--execute"],
    ["--round", "1.5", "--execute"],
    ["--round", "9007199254740992", "--execute"],
  ])
    assert.throws(() => settlementOptions(args));
});
