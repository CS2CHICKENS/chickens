"use client";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import {
  emptyState,
  publicStateSchema,
  type PublicState,
} from "../../../packages/core/src/state";
import { config } from "../../../packages/core/src/index";
import type { Address } from "viem";

export const assetBase = process.env.NEXT_PUBLIC_ASSET_BASE || "/img";
export const dataBase =
  process.env.NEXT_PUBLIC_DATA_BASE || "https://data.cs2chickens.fun";
type Connection = "loading" | "ready" | "unavailable";
const Context = createContext({
  state: emptyState,
  delayed: true,
  connection: "loading" as Connection,
  prices: {} as Record<string, number>,
  refresh: () => {},
});
export function Provider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<PublicState>(emptyState),
    [connection, setConnection] = useState<Connection>("loading"),
    [now, setNow] = useState(0),
    [prices, setPrices] = useState<Record<string, number>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => {
    setConnection("loading");
    setRefreshVersion((version) => version + 1);
  }, []);
  const publishedPrices =
    state.updatedAt > 0 &&
    config.tokens.every((token) =>
      state.tokens.some((published) => published.id === token.id),
    );
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>,
      controller: AbortController | null = null,
      request = 0;
    const poll = async () => {
      if (document.hidden || stopped) return;
      const current = ++request;
      controller?.abort();
      const pending = new AbortController();
      controller = pending;
      const timeout = setTimeout(() => pending.abort(), 10000);
      try {
        const response = await fetch(dataBase + "/state.json", {
          signal: pending.signal,
        });
        if (!response.ok) throw Error();
        const next = publicStateSchema.parse(await response.json());
        if (!stopped && current === request) {
          setState(next);
          setConnection("ready");
        }
      } catch {
        if (!stopped && current === request && !document.hidden)
          setConnection("unavailable");
      } finally {
        clearTimeout(timeout);
        if (!stopped && current === request && !document.hidden)
          timer = setTimeout(
            poll,
            4000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 2001),
          );
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refreshVersion]);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false,
      reading = false;
    let timer: ReturnType<typeof setTimeout>;
    if (
      (!pathname.startsWith("/inventory") &&
        !pathname.startsWith("/tokens/")) ||
      publishedPrices
    )
      return;
    const read = async () => {
      if (document.hidden || cancelled || reading) return;
      reading = true;
      const { client, tokenSnapshot } =
        await import("../../../packages/core/src/chain");
      const rpc = client();
      const rows = await Promise.allSettled(
        config.tokens.map(async (t) => {
          const snapshot = await tokenSnapshot(rpc, t.address as Address);
          return [t.id, Number(snapshot.priceWei) / 1e18] as const;
        }),
      );
      reading = false;
      if (!cancelled) {
        setPrices(
          Object.fromEntries(
            rows.flatMap((row) =>
              row.status === "fulfilled" ? [row.value] : [],
            ),
          ),
        );
        timer = setTimeout(read, 15000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void read();
    };
    void read();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [pathname, publishedPrices]);
  const delayed =
    connection !== "ready" || state.stale || now - state.updatedAt > 180;
  return (
    <Context.Provider value={{ state, delayed, connection, prices, refresh }}>
      {children}
    </Context.Provider>
  );
}
export const useGame = () => useContext(Context);
