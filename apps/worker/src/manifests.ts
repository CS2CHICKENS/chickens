import { json } from "../../../packages/core/src/index";
import type { buildManifest } from "../../../packages/core/src/engine";

export type Manifest = ReturnType<typeof buildManifest>;
type Storage = {
  version: 1;
  pages: number;
  bytes: number;
  contentHash: string;
};
export type ManifestSummary = Manifest & {
  storage?: Storage;
  payoutCount?: number;
  payoutWei?: string;
  carryCount?: number;
  carryWei?: string;
};
export type ManifestReference = { $manifest: number; contentHash: string };
const PAGE_CHARACTERS = 32000;

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    bytes: bytes.length,
    contentHash:
      "0x" +
      Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
  };
}

export async function stageManifest(
  db: D1Database,
  manifest: Manifest,
  checkpoint?: () => Promise<void>,
): Promise<ManifestSummary> {
  const value = json(manifest),
    commitment = await digest(value);
  let page = 0;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + PAGE_CHARACTERS, value.length);
    // Keep a UTF-16 surrogate pair in the same stored page.
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    if (page % 4 === 0) await checkpoint?.();
    await db
      .prepare(
        "INSERT INTO settlement_pages(round,page,contentHash,data) VALUES(?,?,?,?) ON CONFLICT(round,page) DO UPDATE SET contentHash=excluded.contentHash,data=excluded.data",
      )
      .bind(
        manifest.round,
        page++,
        commitment.contentHash,
        value.slice(offset, end),
      )
      .run();
    offset = end;
  }
  return {
    ...manifest,
    payouts: [],
    carry: [],
    weights: {},
    payoutCount: manifest.payouts.length,
    payoutWei: manifest.payouts
      .reduce((sum, row) => sum + BigInt(row.amountWei), 0n)
      .toString(),
    carryCount: manifest.carry.length,
    carryWei: manifest.carry
      .reduce((sum, row) => sum + BigInt(row.amountWei), 0n)
      .toString(),
    storage: { version: 1, pages: page, ...commitment },
  };
}

export async function loadManifestJson(
  db: D1Database,
  round: number,
  summary?: ManifestSummary,
): Promise<string | null> {
  if (!summary) {
    const row = await db
      .prepare("SELECT data FROM manifests WHERE round=?")
      .bind(round)
      .first<{ data: string }>();
    if (!row) return null;
    summary = JSON.parse(row.data) as ManifestSummary;
  }
  if (!summary.storage) return json(summary);
  const storage = summary.storage;
  if (
    storage.version !== 1 ||
    summary.round !== round ||
    !Number.isSafeInteger(storage.pages) ||
    storage.pages < 1
  )
    throw Error("Invalid manifest storage descriptor");
  const parts: string[] = [];
  // Each read is bounded independently of the number of payout recipients.
  for (let page = 0; page < storage.pages; page += 16) {
    const rows = (
      await db
        .prepare(
          "SELECT page,data FROM settlement_pages WHERE round=? AND contentHash=? AND page>=? AND page<? ORDER BY page",
        )
        .bind(
          round,
          storage.contentHash,
          page,
          Math.min(page + 16, storage.pages),
        )
        .all<{ page: number; data: string }>()
    ).results;
    for (const row of rows) {
      if (row.page !== parts.length) throw Error("Incomplete manifest pages");
      parts.push(row.data);
    }
  }
  if (parts.length !== storage.pages) throw Error("Incomplete manifest pages");
  const value = parts.join(""),
    actual = await digest(value);
  if (
    actual.bytes !== storage.bytes ||
    actual.contentHash !== storage.contentHash
  )
    throw Error("Manifest content commitment mismatch");
  const manifest = JSON.parse(value) as Manifest;
  if (manifest.round !== round || manifest.hash !== summary.hash)
    throw Error("Manifest identity mismatch");
  return value;
}

export async function loadManifest(
  db: D1Database,
  round: number,
  summary?: ManifestSummary,
): Promise<Manifest | null> {
  const value = await loadManifestJson(db, round, summary);
  return value === null ? null : (JSON.parse(value) as Manifest);
}

export function manifestReference(
  summary: ManifestSummary,
): ManifestReference | Manifest {
  return summary.storage
    ? { $manifest: summary.round, contentHash: summary.storage.contentHash }
    : summary;
}

export async function publicationValue(
  db: D1Database,
  value: string,
): Promise<string> {
  const reference = JSON.parse(value) as Partial<ManifestReference>;
  if (
    !reference ||
    typeof reference !== "object" ||
    reference.$manifest === undefined
  )
    return value;
  const row = await db
    .prepare("SELECT data FROM manifests WHERE round=?")
    .bind(reference.$manifest)
    .first<{ data: string }>();
  if (!row) throw Error("Missing publication manifest");
  const summary = JSON.parse(row.data) as ManifestSummary;
  if (!summary.storage || reference.contentHash !== summary.storage.contentHash)
    throw Error("Publication manifest commitment mismatch");
  return (await loadManifestJson(db, reference.$manifest, summary))!;
}
