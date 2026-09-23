import { decodeEventLog, type Address, type Hex } from "viem";
import { config, type Token } from "../../../packages/core/src/index";
import {
  client,
  readTokenTrades,
  tokenAbi,
} from "../../../packages/core/src/chain";
import type { buildManifest } from "../../../packages/core/src/engine";
import type { Env } from "./index";
export async function reportCook(
  env: Env,
  input: { round: number; token: string; buyTx: string; burnTx: string },
  rpc = client(env.BACKUP_RPC_URL),
) {
  input = {
    ...input,
    buyTx: input.buyTx.toLowerCase(),
    burnTx: input.burnTx.toLowerCase(),
  };
  const existing = await env.DB.prepare(
    "SELECT round,token,buyTx,burnTx FROM cook_receipts WHERE LOWER(buyTx)=? OR LOWER(burnTx)=?",
  )
    .bind(input.buyTx, input.burnTx)
    .first<{ round: number; token: string; buyTx: string; burnTx: string }>();
  if (existing)
    return existing.round === input.round &&
      existing.token === input.token &&
      existing.buyTx.toLowerCase() === input.buyTx &&
      existing.burnTx.toLowerCase() === input.burnTx
      ? Response.json({ ok: true })
      : new Response("Cook receipt already belongs to another allocation", {
          status: 409,
        });
  const stored = await env.DB.prepare(
    "SELECT data FROM manifests WHERE round=?",
  )
    .bind(input.round)
    .first<{ data: string }>();
  if (!stored) return new Response("Manifest missing", { status: 409 });
  const manifest = JSON.parse(stored.data) as ReturnType<typeof buildManifest>;
  const configured = await env.DB.prepare("SELECT * FROM tokens WHERE id=?")
    .bind(input.token)
    .first<Token>();
  if (!configured || !manifest.cook[input.token])
    return new Response("Cook token is not in the verified plan", {
      status: 409,
    });
  const feed = config.wallets.feed?.toLowerCase();
  if (!feed) return new Response("Feed is not configured", { status: 409 });
  const [buy, burn, head] = await Promise.all([
    rpc.getTransactionReceipt({ hash: input.buyTx as Hex }),
    rpc.getTransactionReceipt({ hash: input.burnTx as Hex }),
    rpc.getBlockNumber(),
  ]);
  if (
    buy.status !== "success" ||
    burn.status !== "success" ||
    buy.from.toLowerCase() !== feed ||
    burn.from.toLowerCase() !== feed ||
    burn.to?.toLowerCase() !== configured.address.toLowerCase() ||
    buy.blockNumber <= BigInt(manifest.endBlock) ||
    burn.blockNumber < buy.blockNumber ||
    (burn.blockNumber === buy.blockNumber &&
      burn.transactionIndex <= buy.transactionIndex) ||
    head < buy.blockNumber + BigInt(config.confirmations) - 1n ||
    head < burn.blockNumber + BigInt(config.confirmations) - 1n
  )
    return new Response("Cook transactions are not confirmed Feed operations", {
      status: 409,
    });
  const token = { ...configured, isToken0: !!configured.isToken0 };
  const buys = (
    await readTokenTrades(rpc, [token], buy.blockNumber, buy.blockNumber)
  ).filter(
    (swap) =>
      swap.tx.toLowerCase() === input.buyTx.toLowerCase() &&
      swap.side === "buy" &&
      swap.kind !== "fee-credit" &&
      (swap.recipient === undefined || swap.recipient.toLowerCase() === feed) &&
      swap.wallet.toLowerCase() === feed &&
      swap.feeVerified &&
      swap.tokenAmountWei !== undefined,
  );
  if (!buys.length)
    return new Response("Purchase recipient cannot be independently verified", {
      status: 409,
    });
  const ethIn = buys.reduce((sum, swap) => sum + swap.volume, 0n),
    received = buys.reduce((sum, swap) => sum + swap.tokenAmountWei!, 0n);
  let burned = 0n,
    actualReceived = 0n;
  for (const log of buy.logs)
    if (log.address.toLowerCase() === token.address.toLowerCase()) {
      try {
        const event = decodeEventLog({
          abi: tokenAbi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
        });
        if (event.args.to.toLowerCase() === feed)
          actualReceived += event.args.value;
        if (event.args.from.toLowerCase() === feed)
          actualReceived -= event.args.value;
      } catch {}
    }
  for (const log of burn.logs)
    if (log.address.toLowerCase() === token.address.toLowerCase()) {
      try {
        const event = decodeEventLog({
          abi: tokenAbi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
        });
        if (
          event.args.from.toLowerCase() === feed &&
          event.args.to.toLowerCase() === config.wallets.burn?.toLowerCase()
        )
          burned += event.args.value;
      } catch {}
    }
  if (
    burned <= 0n ||
    burned !== actualReceived ||
    actualReceived > received ||
    (buys.every((swap) => swap.recipient !== undefined) &&
      actualReceived !== received)
  )
    return new Response("Burn does not match the purchased tokens", {
      status: 409,
    });
  const previous = (
    await env.DB.prepare(
      "SELECT ethIn FROM cook_receipts WHERE round=? AND token=?",
    )
      .bind(input.round, input.token)
      .all<{ ethIn: string }>()
  ).results.reduce((sum, row) => sum + BigInt(row.ethIn), 0n);
  if (previous + ethIn > BigInt(manifest.cook[input.token]))
    return new Response("Cook exceeds the published allocation", {
      status: 409,
    });
  await env.checkpoint?.();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO cook_receipts(round,token,buyTx,burnTx,ethIn,tokensBurned,block) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      input.round,
      input.token,
      input.buyTx,
      input.burnTx,
      ethIn.toString(),
      burned.toString(),
      Number(burn.blockNumber),
    ),
    env.DB.prepare(
      "INSERT INTO cooks(round,token,ethIn,tokensBurned,tx) VALUES(?,?,?,?,?)",
    ).bind(
      input.round,
      input.token,
      ethIn.toString(),
      burned.toString(),
      input.burnTx,
    ),
  ]);
  return Response.json({ ok: true });
}
