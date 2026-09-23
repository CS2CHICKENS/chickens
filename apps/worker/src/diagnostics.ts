import { client } from "../../../packages/core/src/chain";
import { summarizeFailure } from "../../../packages/core/src/rpc-failure";

const phases = [
  "index",
  "settlement",
  "publication",
  "wallets",
  "fees",
  "tick",
] as const;

export function workerRpc(backup?: string) {
  return client(backup, (failure) => console.warn("rpc_failure", failure));
}

export function warnWorkFailure(phase: unknown, error: unknown) {
  try {
    console.warn("background_failure", {
      phase: phases.includes(phase as (typeof phases)[number])
        ? phase
        : "other",
      ...summarizeFailure(error),
    });
  } catch {
    // Logging must never prevent the failed work from being retried.
  }
}
