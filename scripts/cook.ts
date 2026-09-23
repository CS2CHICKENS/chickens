import { run } from "./cli";
import { readFile, writeFile } from "node:fs/promises";
import { settlementOptions, requireSettlementExecutor } from "./execution";
import { config, json } from "../packages/core/src/index";
import type { buildManifest } from "../packages/core/src/engine";

async function main() {
  const { round, dryRun } = settlementOptions();
  if (!dryRun) requireSettlementExecutor();
  const manifest = JSON.parse(
    await readFile(
      "private/payout-runs/round-" + round + "-verified.json",
      "utf8",
    ),
  ) as ReturnType<typeof buildManifest>;
  const schedule = Object.entries(manifest.cook).flatMap(([token, amount]) =>
    Array.from({ length: config.cook.chunks }, (_, i) => ({
      token,
      ethIn: (
        BigInt(amount) / BigInt(config.cook.chunks) +
        (i === config.cook.chunks - 1
          ? BigInt(amount) % BigInt(config.cook.chunks)
          : 0n)
      ).toString(),
      afterSeconds: Math.round(
        (i * config.cook.spreadMinutes * 60) / (config.cook.chunks - 1),
      ),
      maxSlippageBps: config.cook.maxSlippageBps,
    })),
  );
  await writeFile(
    "private/payout-runs/round-" + round + "-cook-plan.json",
    json({ round, manifestHash: manifest.hash, schedule }),
  );
  console.log(
    "Cook schedule prepared: " +
      schedule.length +
      " chunks over " +
      config.cook.spreadMinutes +
      " minutes.",
  );
}
run(main);
