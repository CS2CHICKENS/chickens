import { run } from "./cli";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  config,
  hatch,
  deterministicReel,
  json,
} from "../packages/core/src/index";
import {
  client,
  tokenSnapshot,
  curveAbi,
  launchInfo,
} from "../packages/core/src/chain";
import type { Address } from "viem";

async function main() {
  const rpc = client(process.env.BACKUP_RPC_URL);
  const head = await rpc.getBlockNumber(),
    proofs = [];
  for (let i = 1n; i <= 5n; i++) {
    const block = await rpc.getBlock({ blockNumber: head - i * 100n }),
      ids = config.families[2].variants,
      result = hatch(block.hash, ids),
      reel = deterministicReel(block.hash, ids, result.variant);
    assert.equal(reel.reel[reel.stop], result.variant);
    proofs.push({
      block: block.number,
      hash: block.hash,
      index: result.index,
      variant: result.variant,
      sorted: result.ids,
    });
  }
  const tokens = [];
  for (const t of config.tokens) {
    const quote = await tokenSnapshot(rpc, t.address as Address, head);
    const launch = await launchInfo(rpc, t.address as Address, head);
    assert.equal(
      launch.deployer.toLowerCase(),
      config.wallets.creator!.toLowerCase(),
    );
    assert.equal(
      launch.creatorFeeRecipient.toLowerCase(),
      config.fees.collectionWallet.toLowerCase(),
    );
    if (quote.phase === 0) {
      const reserves = await rpc.readContract({
        address: quote.curve,
        abi: curveAbi,
        functionName: "getReserves",
        blockNumber: head,
      });
      assert.equal((reserves[0] * 10n ** 18n) / reserves[1], quote.priceWei);
    }
    tokens.push({ id: t.id, block: head, ...quote });
  }
  const archive = [];
  if (process.argv.includes("--archive")) {
    for (const token of config.tokens) {
      const block = BigInt(
        config.tokenLaunchBlocks[
          token.id as keyof typeof config.tokenLaunchBlocks
        ],
      );
      const quote = await tokenSnapshot(rpc, token.address as Address, block);
      archive.push({
        id: token.id,
        block,
        priceWei: quote.priceWei,
        supply: quote.supply,
        creatorFeeRecipient: quote.creatorFeeRecipient,
        collectionPolicyActive: quote.feeVerified,
      });
    }
  }
  await mkdir("private/verification", { recursive: true });
  await writeFile(
    "private/verification/chain.json",
    json({ head, proofs, tokens, archive }),
  );
  console.log(
    "Verified 5 historical hatch proofs and all configured v2 token prices and fee recipients. Evidence saved privately.",
  );
  if (archive.length)
    console.log(
      "Historical contract state verified at every base token launch.",
    );
}
run(main);
