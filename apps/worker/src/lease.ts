import type { Env } from "./index";

export class LedgerBusy extends Error {
  constructor() {
    super("Ledger update in progress");
  }
}

export async function withLedgerLease<T>(
  env: Env,
  work: (locked: Env) => Promise<T>,
  requireLease = true,
): Promise<T | undefined> {
  const now = Math.floor(Date.now() / 1000);
  let lease = String(now + 600);
  const acquired = await env.DB.prepare(
    "INSERT INTO meta(key,value) VALUES('lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(meta.value AS INTEGER) < ? RETURNING value",
  )
    .bind(lease, now)
    .first();
  if (!acquired) {
    if (requireLease) throw new LedgerBusy();
    return;
  }
  let renewing: Promise<void> | undefined;
  const checkpoint = () => {
    renewing ??= (async () => {
      const current = Math.floor(Date.now() / 1000),
        next = String(current + 600);
      const renewed = await env.DB.prepare(
        "UPDATE meta SET value=? WHERE key='lease' AND value=? AND CAST(value AS INTEGER)>=? RETURNING value",
      )
        .bind(next, lease, current)
        .first();
      if (!renewed) throw Error("Indexer lease expired or changed");
      lease = next;
    })().finally(() => {
      renewing = undefined;
    });
    return renewing;
  };
  try {
    return await work({ ...env, checkpoint });
  } finally {
    await env.DB.prepare("DELETE FROM meta WHERE key='lease' AND value=?")
      .bind(lease)
      .run();
  }
}
