import { json } from "../../../packages/core/src/index";
import type { Env } from "./index";
import { publicationValue } from "./manifests";
export const metadata = {
  httpMetadata: {
    contentType: "application/json",
    cacheControl: "public, max-age=4",
  },
};
export async function all<T>(
  db: D1Database,
  query: string,
  bindings: unknown[] = [],
  maximum = 50000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await db
      .prepare(query + " LIMIT 1000 OFFSET ?")
      .bind(...bindings, offset)
      .all<T>();
    rows.push(...page.results);
    if (rows.length > maximum)
      throw Error("Query exceeded the configured work budget");
    if (page.results.length < 1000) return rows;
  }
}
export async function meta(db: D1Database, key: string) {
  return (
    await db
      .prepare("SELECT value FROM meta WHERE key=?")
      .bind(key)
      .first<{ value: string }>()
  )?.value;
}
export function metaStatement(db: D1Database, key: string, value: string) {
  return db
    .prepare(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(key, value);
}
export async function putMeta(db: D1Database, key: string, value: string) {
  await metaStatement(db, key, value).run();
}
export async function statements(db: D1Database, list: D1PreparedStatement[]) {
  for (let offset = 0; offset < list.length; offset += 80)
    await db.batch(list.slice(offset, offset + 80));
}
export function insertRows(
  db: D1Database,
  table: string,
  columns: string[],
  rows: unknown[][],
) {
  const queries: D1PreparedStatement[] = [],
    width = Math.floor(100 / columns.length);
  for (let offset = 0; offset < rows.length; offset += width) {
    const values = rows.slice(offset, offset + width);
    queries.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO " +
            table +
            "(" +
            columns.join(",") +
            ") VALUES " +
            values
              .map(() => "(" + columns.map(() => "?").join(",") + ")")
              .join(","),
        )
        .bind(...values.flat()),
    );
  }
  return queries;
}
export async function alert(env: Env, id: string, message: string) {
  await env.checkpoint?.();
  await env.DB.prepare("INSERT OR IGNORE INTO alerts VALUES(?,?,?,?)")
    .bind(id, Math.floor(Date.now() / 1000), "error", message)
    .run();
}
export function queuePublication(db: D1Database, key: string, value: unknown) {
  return db
    .prepare(
      "INSERT INTO data_publications(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(key, json(value));
}
export async function flushPublications(env: Env, limit = 20) {
  const { results } = await env.DB.prepare(
    "SELECT key,value FROM data_publications ORDER BY key LIMIT ?",
  )
    .bind(limit)
    .all<{ key: string; value: string }>();
  for (const row of results) {
    await env.checkpoint?.();
    await env.DATA.put(
      row.key,
      await publicationValue(env.DB, row.value),
      metadata,
    );
    await env.DB.prepare(
      "DELETE FROM data_publications WHERE key=? AND value=?",
    )
      .bind(row.key, row.value)
      .run();
  }
}
export async function applyBalances(
  db: D1Database,
  maximumBatches = 40,
  checkpoint?: () => Promise<void>,
) {
  for (let batch = 0; batch < maximumBatches; batch++) {
    await checkpoint?.();
    const { results } = await db
      .prepare(
        "SELECT id,token,wallet,delta FROM balance_events WHERE applied=0 ORDER BY block,logIndex,id LIMIT 40",
      )
      .all<{ id: string; token: string; wallet: string; delta: string }>();
    if (!results.length) return true;
    const keys = [
      ...new Map(
        results.map((row) => [
          row.token + ":" + row.wallet,
          { token: row.token, wallet: row.wallet },
        ]),
      ).values(),
    ];
    const previous = await db
      .prepare(
        "SELECT token,wallet,balanceWei FROM current_balances WHERE " +
          keys.map(() => "(token=? AND wallet=?)").join(" OR "),
      )
      .bind(...keys.flatMap((row) => [row.token, row.wallet]))
      .all<{ token: string; wallet: string; balanceWei: string }>();
    const balances = new Map(
      keys.map((row) => [row.token + ":" + row.wallet, { ...row, amount: 0n }]),
    );
    for (const row of previous.results)
      balances.get(row.token + ":" + row.wallet)!.amount = BigInt(
        row.balanceWei,
      );
    for (const row of results)
      balances.get(row.token + ":" + row.wallet)!.amount += BigInt(row.delta);
    const values = [...balances.values()];
    if (values.some((row) => row.amount < 0n))
      throw Error("Incomplete opening balance history");
    const writes: D1PreparedStatement[] = [];
    for (let offset = 0; offset < values.length; offset += 30) {
      const rows = values.slice(offset, offset + 30);
      writes.push(
        db
          .prepare(
            "INSERT INTO current_balances(token,wallet,balanceWei) VALUES " +
              rows.map(() => "(?,?,?)").join(",") +
              " ON CONFLICT(token,wallet) DO UPDATE SET balanceWei=excluded.balanceWei",
          )
          .bind(
            ...rows.flatMap((row) => [
              row.token,
              row.wallet,
              row.amount.toString(),
            ]),
          ),
      );
    }
    const wallets = [...new Set(values.map((row) => row.wallet))];
    writes.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO wallet_dirty(wallet) VALUES " +
            wallets.map(() => "(?)").join(","),
        )
        .bind(...wallets),
    );
    writes.push(
      db
        .prepare(
          "UPDATE balance_events SET applied=1 WHERE id IN (" +
            results.map(() => "?").join(",") +
            ")",
        )
        .bind(...results.map((row) => row.id)),
    );
    await db.batch(writes);
  }
  return false;
}
