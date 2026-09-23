import { config } from "./index";

export function settlementGasReference(
  baseFeePerGas: bigint | null | undefined,
) {
  if (
    baseFeePerGas === null ||
    baseFeePerGas === undefined ||
    baseFeePerGas < 0n
  )
    throw Error("End-block base fee is required for the payout cutoff");
  const { gasBaseFeeMultiplier, gasPriorityFeeWei, gasUnitsPerRecipient } =
    config.payouts;
  if (
    !Number.isSafeInteger(gasBaseFeeMultiplier) ||
    gasBaseFeeMultiplier < 1 ||
    !Number.isSafeInteger(gasUnitsPerRecipient) ||
    gasUnitsPerRecipient < 21000 ||
    !/^[0-9]+$/.test(gasPriorityFeeWei)
  )
    throw Error("Invalid payout gas reference configuration");
  return (
    (baseFeePerGas * BigInt(gasBaseFeeMultiplier) + BigInt(gasPriorityFeeWei)) *
    BigInt(gasUnitsPerRecipient)
  );
}
