import { parseArgs } from "node:util";

export function requireSettlementExecutor() {
  throw Error(
    "CLI execution is disabled. Use npm run operator and confirm transactions in Rabby.",
  );
}

export function settlementOptions(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      round: { type: "string" },
      "dry-run": { type: "boolean" },
      execute: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.round || !/^[1-9]\d*$/.test(values.round))
    throw Error("Provide a positive round number with --round.");
  const round = Number(values.round);
  if (!Number.isSafeInteger(round))
    throw Error("Round number is out of range.");
  if (values.execute && values["dry-run"])
    throw Error("Choose either --dry-run or --execute.");
  return { round, dryRun: values.execute !== true };
}
