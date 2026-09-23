import { run } from "./cli";
import { reconstruct, roundArg } from "./history";
import { hatch, firstBlockAt, json } from "../packages/core/src/index";

async function main() {
  const round = roundArg(),
    { rpc, result } = await reconstruct();
  const h = result.hatches.find((h) => h.round === round);
  if (!h) throw Error("Round has no hatch");
  if (h.block === null || !h.hash || !h.variant)
    throw Error("Hatch is awaiting its confirmed block");
  const blockNumber = await firstBlockAt(
    (n) => rpc.getBlock({ blockNumber: n }),
    BigInt(result.rounds[round - 1].endBlock),
    BigInt(h.block),
    BigInt(h.hatchAt),
  );
  const block = await rpc.getBlock({ blockNumber }),
    proof = hatch(block.hash, h.remaining);
  if (
    Number(blockNumber) !== h.block ||
    block.hash !== h.hash ||
    proof.variant !== h.variant
  )
    throw Error(
      "Hatch proof changed; reconcile the confirmed chain before launch",
    );
  console.log(
    json({
      round,
      block: blockNumber,
      hash: block.hash,
      sorted: proof.ids,
      index: proof.index,
      result: proof.variant,
      tweet:
        proof.variant +
        " hatched in round " +
        round +
        ". Verify block " +
        blockNumber +
        " at https://cs2chickens.fun/incubator/",
    }),
  );
}
run(main);
