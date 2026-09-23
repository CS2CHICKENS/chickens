import type { Hex } from "viem";
import type { payoutBatches } from "../packages/core/src/batches";

export type PayoutBatch = ReturnType<typeof payoutBatches>[number];
export type BatchJournal = {
  status: "prepared" | "submitted" | "confirmed" | "reported";
  manifestHash: string;
  batchHash: string;
  preparedBlock: number;
  nonce: number;
  tx?: Hex;
  gasWei?: string;
};
export type BatchActions = {
  read(): Promise<BatchJournal | null>;
  write(value: BatchJournal, exclusive?: boolean): Promise<void>;
  prepare(): Promise<{ nonce: number; preparedBlock: number }>;
  submit(prepared: BatchJournal): Promise<Hex>;
  recover(prepared: BatchJournal): Promise<Hex | null>;
  verify(tx: Hex, prepared: BatchJournal): Promise<{ tx: Hex; gasWei: bigint }>;
  report(tx: Hex): Promise<void>;
};

export async function settleBatch(
  manifestHash: string,
  batch: PayoutBatch,
  actions: BatchActions,
) {
  let journal = await actions.read();
  if (journal) {
    if (
      journal.manifestHash !== manifestHash ||
      journal.batchHash !== batch.hash ||
      !Number.isSafeInteger(journal.nonce) ||
      journal.nonce < 0 ||
      !Number.isSafeInteger(journal.preparedBlock) ||
      journal.preparedBlock < 0 ||
      !["prepared", "submitted", "confirmed", "reported"].includes(
        journal.status,
      )
    )
      throw Error("Batch journal does not match this settlement");
    if (!journal.tx) {
      const tx = await actions.recover(journal);
      if (!tx)
        throw Error(
          "Submission uncertain; no new payment sent. Reconcile the reserved nonce.",
        );
      journal = { ...journal, status: "submitted", tx };
      await actions.write(journal);
    }
  } else {
    journal = {
      status: "prepared",
      manifestHash,
      batchHash: batch.hash,
      ...(await actions.prepare()),
    };
    await actions.write(journal, true);
    const tx = await actions.submit(journal);
    journal = { ...journal, status: "submitted", tx };
    await actions.write(journal);
  }
  const verified = await actions.verify(journal.tx!, journal);
  journal = {
    ...journal,
    status: "confirmed",
    tx: verified.tx,
    gasWei: verified.gasWei.toString(),
  };
  await actions.write(journal);
  await actions.report(verified.tx);
  journal = { ...journal, status: "reported" };
  await actions.write(journal);
  return journal;
}

export function outstandingPrincipal(
  batches: PayoutBatch[],
  confirmedBatches: ReadonlySet<string>,
  cookWei: bigint,
  cookConfirmed: boolean,
) {
  if (cookWei < 0n) throw Error("Invalid cook principal");
  return (
    batches
      .filter((b) => !confirmedBatches.has(b.hash))
      .reduce((sum, b) => sum + b.value, 0n) + (cookConfirmed ? 0n : cookWei)
  );
}
