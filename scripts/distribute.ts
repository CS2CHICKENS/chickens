import { run } from "./cli";
import { mkdir, writeFile } from "node:fs/promises";
import { json } from "../packages/core/src/index";
import { payoutBatches } from "../packages/core/src/batches";
import { prepareRound } from "./operator-plan";
import { settlementOptions, requireSettlementExecutor } from "./execution";
async function main() {
  const { round, dryRun } = settlementOptions();
  if (!dryRun) requireSettlementExecutor();
  const prepared = await prepareRound(round);
  await mkdir("private/payout-runs", { recursive: true });
  await writeFile(
    "private/payout-runs/round-" + round + "-verified.json",
    json(prepared.manifest),
  );
  console.log(
    "Verified round " +
      round +
      ": " +
      payoutBatches(prepared.manifest.payouts).length +
      " batches. No transactions sent. Use npm run operator for Rabby settlement.",
  );
}
run(main);
