import {
  encodeAbiParameters,
  keccak256,
  isAddress,
  zeroAddress,
  type Address,
} from "viem";
export function payoutBatches(
  rows: { wallet: Address; amountWei: string | bigint }[],
  size = 200,
) {
  if (!Number.isInteger(size) || size < 1 || size > 200)
    throw Error("Invalid batch size");
  const recipients = new Map<Address, bigint>();
  for (const row of rows) {
    const wallet = row.wallet.toLowerCase() as Address;
    if (
      !isAddress(wallet) ||
      wallet === zeroAddress ||
      BigInt(row.amountWei) <= 0n
    )
      throw Error("Invalid payout recipient or amount");
    recipients.set(
      wallet,
      (recipients.get(wallet) ?? 0n) + BigInt(row.amountWei),
    );
  }
  const addresses = [...recipients.keys()].sort(),
    batches = [];
  for (let i = 0; i < addresses.length; i += size) {
    const to = addresses.slice(i, i + size),
      amounts = to.map((a) => recipients.get(a)!),
      value = amounts.reduce((a, b) => a + b, 0n);
    const hash = keccak256(
      encodeAbiParameters(
        [{ type: "address[]" }, { type: "uint256[]" }],
        [to, amounts],
      ),
    );
    batches.push({ index: batches.length, to, amounts, value, hash });
  }
  return batches;
}
