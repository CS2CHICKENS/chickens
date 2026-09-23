"use client";
import { useEffect, useId, useState } from "react";
import { z } from "zod";
import {
  publicStateSchema,
  walletLedgerSchema,
} from "../../../packages/core/src/state";
import { dataBase } from "./data";

const schemas = {
  rounds: publicStateSchema.shape.history.shape.rounds,
  received: walletLedgerSchema.shape.received,
};
type Archive = {
  pageSize: number;
  totalPages: number;
  basePath: string;
  ready?: boolean;
};
export function useArchive<T>(
  latest: T[],
  archive: Archive | undefined,
  kind: keyof typeof schemas,
  address?: string,
) {
  const [page, setPage] = useState(-1),
    [rows, setRows] = useState<T[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  const basePath = archive?.basePath,
    ready = archive?.ready;
  useEffect(() => {
    setPage(-1);
  }, [basePath]);
  useEffect(() => {
    if (page < 0 || !basePath) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setRows([]);
    (async () => {
      try {
        // Archive locations must remain below the configured public data origin.
        if (
          !/^(history\/rounds\/|wallets\/0x[0-9a-fA-F]{40}\/received\/)$/.test(
            basePath,
          )
        )
          throw Error();
        const response = await fetch(
          dataBase + "/" + basePath + page + ".json",
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        if (response.status === 404 && kind === "received" && ready === true)
          return;
        if (!response.ok) throw Error();
        const body = await response.json();
        z.object({ page: z.literal(page), pageSize: z.literal(100) }).parse(
          body,
        );
        if (address && body.address?.toLowerCase() !== address.toLowerCase())
          throw Error();
        const parsed = schemas[kind].parse(body[kind]) as T[];
        if (!controller.signal.aborted) setRows(parsed);
      } catch {
        if (!controller.signal.aborted)
          setError(
            "This archive is unavailable or still updating. Retry shortly; missing data does not mean zero payments.",
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [page, basePath, kind, address, ready, retry]);
  return {
    rows: page < 0 ? latest : rows,
    page,
    setPage,
    busy: page >= 0 && busy,
    error: page >= 0 ? error : "",
    retry: () => setRetry((value) => value + 1),
    archive,
  };
}
export function ArchivePicker({
  view,
  label,
}: {
  view: ReturnType<typeof useArchive>;
  label: string;
}) {
  const id = useId();
  if (!view.archive?.totalPages) return null;
  return (
    <div className="archive-picker">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={view.page}
        onChange={(event) => view.setPage(Number(event.target.value))}
      >
        <option value={-1}>Latest records</option>
        {Array.from(
          { length: view.archive.totalPages },
          (_, offset) => view.archive!.totalPages - offset - 1,
        ).map((page) => (
          <option key={page} value={page}>
            Rounds {page * view.archive!.pageSize + 1}–
            {(page + 1) * view.archive!.pageSize}
          </option>
        ))}
      </select>
      {view.busy && <span role="status">Loading archive…</span>}
      {view.error && (
        <p role="alert">
          {view.error}{" "}
          <button type="button" onClick={view.retry}>
            RETRY
          </button>
        </p>
      )}
    </div>
  );
}
