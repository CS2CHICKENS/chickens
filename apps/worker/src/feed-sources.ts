import { config, type Token } from "../../../packages/core/src/index";
import type { PublicState } from "../../../packages/core/src/state";
import type { Env } from "./index";

type Change = {
  sequence: number;
  token: string;
  volumeWei: string;
  creatorFeeWei: string | null;
  feeVerified: number | null;
  direction: number;
};
type Stored = {
  token: string;
  volumeWei: string;
  creatorFeeWei: string;
  unverifiedCount: number;
};
type Total = {
  volume: bigint;
  fees: bigint;
  unverified: number;
};
function amount(value: string) {
  if (!/^\d+$/.test(value)) throw Error("Invalid feed source amount");
  return BigInt(value);
}

export async function maintainFeedSources(
  env: Env,
  tokens: Pick<Token, "id">[],
  indexedBlock: number,
  limit = 1000,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw Error("Invalid feed source work budget");
  if (!Number.isSafeInteger(indexedBlock) || indexedBlock < 0)
    throw Error("Invalid feed source block");
  const changes = (
    await env.DB.prepare(
      "SELECT sequence,token,volumeWei,creatorFeeWei,feeVerified,direction FROM feed_source_changes ORDER BY sequence LIMIT ?",
    )
      .bind(limit + 1)
      .all<Change>()
  ).results;
  const used = changes.slice(0, limit);
  const ids = [
    ...new Set([
      ...tokens.map((token) => token.id),
      ...used.map((row) => row.token),
    ]),
  ];
  const totals = new Map<string, Total>();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const group = ids.slice(offset, offset + 50);
    const rows = (
      await env.DB.prepare(
        "SELECT token,volumeWei,creatorFeeWei,unverifiedCount FROM feed_source_totals WHERE token IN (" +
          group.map(() => "?").join(",") +
          ")",
      )
        .bind(...group)
        .all<Stored>()
    ).results;
    for (const row of rows)
      totals.set(row.token, {
        volume: amount(row.volumeWei),
        fees: amount(row.creatorFeeWei),
        unverified: row.unverifiedCount,
      });
  }
  const changed = new Set<string>();
  for (const row of used) {
    if (row.direction !== 1 && row.direction !== -1)
      throw Error("Invalid feed source direction");
    const total = totals.get(row.token) ?? {
      volume: 0n,
      fees: 0n,
      unverified: 0,
    };
    total.volume += BigInt(row.direction) * amount(row.volumeWei);
    if (row.feeVerified === 1 && row.creatorFeeWei !== null)
      total.fees += BigInt(row.direction) * amount(row.creatorFeeWei);
    else total.unverified += row.direction;
    totals.set(row.token, total);
    changed.add(row.token);
  }
  for (const total of totals.values())
    if (
      total.volume < 0n ||
      total.fees < 0n ||
      !Number.isSafeInteger(total.unverified) ||
      total.unverified < 0
    )
      throw Error("Invalid feed source aggregate");
  if (used.length) {
    const writes: D1PreparedStatement[] = [];
    const rows = [...changed].map((token) => {
      const total = totals.get(token)!;
      return [
        token,
        total.volume.toString(),
        total.fees.toString(),
        total.unverified,
      ];
    });
    for (let offset = 0; offset < rows.length; offset += 25) {
      const group = rows.slice(offset, offset + 25);
      writes.push(
        env.DB.prepare(
          "INSERT INTO feed_source_totals(token,volumeWei,creatorFeeWei,unverifiedCount) VALUES " +
            group.map(() => "(?,?,?,?)").join(",") +
            " ON CONFLICT(token) DO UPDATE SET volumeWei=excluded.volumeWei,creatorFeeWei=excluded.creatorFeeWei,unverifiedCount=excluded.unverifiedCount",
        ).bind(...group.flat()),
      );
    }
    writes.push(
      env.DB.prepare("DELETE FROM feed_source_changes WHERE sequence<=?").bind(
        used.at(-1)!.sequence,
      ),
    );
    await env.checkpoint?.();
    await env.DB.batch(writes);
  }
  const metadata = (
    await env.DB.prepare(
      "SELECT key,value FROM meta WHERE key IN ('indexStart','stagedRange')",
    ).all<{ key: string; value: string }>()
  ).results;
  const fromBlock = Number(
    metadata.find((row) => row.key === "indexStart")?.value ??
      config.factoryStartBlock,
  );
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0)
    throw Error("Invalid feed source start block");
  const more = changes.length > limit;
  const ready =
    !more &&
    !metadata.some((row) => row.key === "stagedRange") &&
    indexedBlock >= fromBlock;
  const sources: NonNullable<PublicState["feed"]["sources"]> = {
    ready,
    fromBlock,
    throughBlock: ready ? indexedBlock : null,
    totals: ready
      ? [...new Set(tokens.map((token) => token.id))].sort().map((token) => {
          const total = totals.get(token) ?? {
            volume: 0n,
            fees: 0n,
            unverified: 0,
          };
          return {
            token,
            volumeWei: total.volume.toString(),
            creatorFeeWei: total.unverified ? null : total.fees.toString(),
          };
        })
      : [],
  };
  return { sources, more };
}
