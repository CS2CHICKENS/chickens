"use client";
import Link from "next/link";
import { NestPreview, KitchenScene } from "./scenes";
import { FamilyHelp } from "./help";
import { Participation } from "./participation";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef, type CSSProperties } from "react";
import { motion, AnimatePresence } from "motion/react";
import { formatEther } from "viem";
import { config } from "../../../packages/core/src/index";
import { Provider, useGame, assetBase } from "./data";
export const explorer = "https://robinhoodchain.blockscout.com";
export const colors: Record<string, string> = {
  catalana: "#dea34f",
  polish: "#80a8ce",
  silkie: "#ac95c8",
};
export const human = (id: string) => id.split("-").join(" ");
export const eth = (wei: string | bigint, digits = 4) =>
  Number(formatEther(BigInt(wei))).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
export const short = (value: string) =>
  value.length > 15 ? value.slice(0, 6) + "…" + value.slice(-4) : value;
export function Art({
  id,
  className = "",
  locked = false,
  eager = false,
}: {
  id: string;
  className?: string;
  locked?: boolean;
  eager?: boolean;
}) {
  return (
    <picture className={"art " + className}>
      {!locked && (
        <source
          type="image/avif"
          srcSet={[256, 512, 1024]
            .map((w) => assetBase + "/" + id + "-" + w + ".avif " + w + "w")
            .join(",")}
          sizes="(max-width: 600px) 45vw, 300px"
        />
      )}
      <img
        src={assetBase + "/" + id + (locked ? "-locked.webp" : "-512.webp")}
        srcSet={
          locked
            ? undefined
            : [256, 512, 1024]
                .map((w) => assetBase + "/" + id + "-" + w + ".webp " + w + "w")
                .join(",")
        }
        sizes="(max-width: 600px) 45vw, 300px"
        alt={human(id)}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        width="512"
        height="512"
      />
    </picture>
  );
}
export function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy"
      aria-label={"Copy " + value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "COPIED" : short(value)} <span aria-hidden="true">⧉</span>
    </button>
  );
}
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Provider>
      <Frame>{children}</Frame>
    </Provider>
  );
}
function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname(),
    { state, delayed, connection } = useGame();
  const [open, setOpen] = useState(false);
  const navigation = useRef<HTMLElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    navigation.current?.querySelector("a")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  const routes = [
    ["/", "Play"],
    ["/inventory", "Inventory"],
    ["/incubator", "Incubator"],
    ["/rounds", "Rounds"],
    ["/kitchen", "Kitchen"],
    ["/feed", "The feed"],
    ["/check", "Check wallet"],
    ["/whitepaper", "Rules"],
  ];
  return (
    <>
      <header className="header">
        <Link href="/" className="brand" aria-label="CS2 Chickens home">
          <picture>
            <source
              type="image/avif"
              srcSet={
                assetBase +
                "/brand-logo-256.avif 256w, " +
                assetBase +
                "/brand-logo-512.avif 512w, " +
                assetBase +
                "/brand-logo-1024.avif 1024w"
              }
              sizes="(max-width: 600px) 160px, 200px"
            />
            <img
              src={assetBase + "/brand-logo-512.webp"}
              srcSet={
                assetBase +
                "/brand-logo-256.webp 256w, " +
                assetBase +
                "/brand-logo-512.webp 512w, " +
                assetBase +
                "/brand-logo-1024.webp 1024w"
              }
              sizes="(max-width: 600px) 160px, 200px"
              width="600"
              height="200"
              alt="CS2 Chickens"
            />
          </picture>
        </Link>
        <nav
          ref={navigation}
          id="main-navigation"
          aria-label="Main navigation"
          className={open ? "open" : ""}
        >
          {routes.map(([url, label]) => (
            <Link
              key={url}
              href={url}
              aria-current={
                path === url || (url !== "/" && path.startsWith(url + "/"))
                  ? "page"
                  : undefined
              }
              onClick={() => setOpen(false)}
            >
              {label}
            </Link>
          ))}
        </nav>
        <span className="network">
          <b /> ROBINHOOD CHAIN
        </span>
        <button
          className="menu"
          ref={menuButton}
          aria-expanded={open}
          aria-controls="main-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? "CLOSE" : "MENU"} ≡
        </button>
      </header>
      <div className="status-strip">
        <span>
          <b
            className={
              !delayed && (state.mode === "live" || state.mode === "monitoring")
                ? "live"
                : ""
            }
          />{" "}
          {connection === "unavailable" && !state.updatedAt
            ? "PUBLIC DATA UNAVAILABLE"
            : connection === "loading" && !state.updatedAt
              ? "CONNECTING TO PUBLIC DATA"
              : delayed && state.updatedAt > 0
                ? "DATA DELAYED · LAST VERIFIED RECORD"
                : state.mode === "live"
                  ? "SEASON 01 · LIVE"
                  : state.mode === "monitoring"
                    ? "LIVE MARKETS · ROUNDS NOT ACTIVATED"
                    : state.mode === "demo"
                      ? "LOCAL SIMULATION · NO REAL REWARDS"
                      : "SEASON 01 · AWAITING ACTIVATION"}
        </span>
        <Link
          href="/status"
          className="status-link"
          aria-label="View data freshness and payment status"
        >
          {state.updatedAt
            ? "BLOCK " + state.headBlock.toLocaleString("en-US")
            : "PUBLIC CHAIN · PUBLIC PROOF"}
          {" ↗"}
        </Link>
      </div>
      {delayed && state.updatedAt > 0 && (
        <div role="status" className="delay">
          Data delayed · showing the last verified state.{" "}
          <Link href="/status">CHECK DATA STATUS ↗</Link>
        </div>
      )}
      {connection === "unavailable" && !state.updatedAt && (
        <div role="status" className="delay">
          Public data is unavailable. Amounts are unknown; retrying
          automatically. <Link href="/status">CHECK DATA STATUS ↗</Link>
        </div>
      )}
      <main>{children}</main>
      <footer>
        <div className="footer-head">
          <strong>
            EVERY CHICKEN.
            <br />
            <em>ON THE RECORD.</em>
          </strong>
          <div>
            <Link href="/whitepaper">Read the rules ↗</Link>
            <Link href="/verify">Verify a token ↗</Link>
            <Link href="/status">Data & payments ↗</Link>
            {config.socials.x && (
              <a href={config.socials.x}>@CS2Chickens on X ↗</a>
            )}
          </div>
        </div>
        <div className="addresses">
          {[
            ...config.tokens,
            ...state.tokens.filter(
              (t) => !config.tokens.some((c) => c.id === t.id),
            ),
          ].map((t) => (
            <div key={t.id}>
              <span>{t.id.toUpperCase()}</span>
              <Copy value={t.address} />
            </div>
          ))}
        </div>
        <div className="legal">
          <span>Not affiliated with Valve.</span>
          <p>
            Meme tokens have no intrinsic value and can go to zero. Rewards
            depend on volume. No promised returns. Verify every address.
          </p>
          <span>CS2 CHICKENS / SEASON 01</span>
        </div>
      </footer>
    </>
  );
}
export function Title({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail?: string;
}) {
  return (
    <div className="title">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      {detail && <p>{detail}</p>}
    </div>
  );
}
export function Timer({ at }: { at: number }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.floor(at - now));
  return (
    <span className="digits">
      {at && now
        ? [Math.floor(left / 3600), Math.floor(left / 60) % 60, left % 60]
            .map((n) => String(n).padStart(2, "0"))
            .join(":")
        : "--:--:--"}
    </span>
  );
}
function Race() {
  const { state } = useGame();
  const active = state.mode === "live" || state.mode === "demo";
  const families = [...config.families].sort((a, b) =>
    Number(
      BigInt(state.round.volumeByFamily[b.id] || 0) -
        BigInt(state.round.volumeByFamily[a.id] || 0),
    ),
  );
  return (
    <section className="race panel">
      <div className="section-label">
        <h2>FAMILY RACE</h2>
        <span>
          {active
            ? "ROUND " + String(state.round.id).padStart(2, "0")
            : "AWAITING ACTIVATION"}
        </span>
      </div>
      <div className="score-label">
        <span>FAMILY</span>
        <span>VOLUME / ETH</span>
        <span>WINS</span>
      </div>
      {families.map((f, i) => {
        const volume = state.round.volumeByFamily[f.id] || "0";
        const progress = BigInt(state.round.threshold)
          ? Number((BigInt(volume) * 10000n) / BigInt(state.round.threshold)) /
            100
          : 0;
        return (
          <Link
            href={"/inventory/" + f.id}
            className="score-row"
            key={f.id}
            style={{ "--family": colors[f.id] } as CSSProperties}
          >
            <span className="rank">0{i + 1}</span>
            <Art id={f.id} eager />
            <div className="family-name">
              <strong>{f.name.toUpperCase()}</strong>
              <div className="track">
                <motion.i
                  initial={false}
                  animate={{ scaleX: Math.min(1, progress / 100) }}
                />
              </div>
            </div>
            <span className="digits">
              {state.updatedAt && active ? eth(volume, 2) : "—"}
            </span>
            <span className="wins">
              {(
                state.history.wins?.[f.id] ??
                state.history.rounds.filter((r) => r.winner === f.id).length
              )
                .toString()
                .padStart(2, "0")}
            </span>
          </Link>
        );
      })}
      <div className="panel-note">
        Family volume sets the pace. The whole family counts.
      </div>
    </section>
  );
}
export function RoundHud() {
  const { state } = useGame();
  const active = state.mode === "live" || state.mode === "demo";
  return (
    <section className="round-hud">
      <div>
        <span className="eyebrow">
          {active
            ? "ROUND " + String(state.round.id).padStart(2, "0")
            : "SEASON 01"}
        </span>
        <strong>{active ? "THE RACE IS ON" : "ROUNDS NOT ACTIVATED"}</strong>
      </div>
      <div className="threshold">
        <div>
          <span>FAMILY VOLUME</span>
          <span className="digits">
            {active && state.round.threshold !== "0"
              ? eth(
                  Object.values(state.round.volumeByFamily).reduce(
                    (a, b) => a + BigInt(b),
                    0n,
                  ),
                  2,
                ) +
                " / " +
                eth(state.round.threshold, 2) +
                " ETH"
              : "THRESHOLD PENDING"}
          </span>
        </div>
        <div className="track">
          <motion.i
            initial={false}
            animate={{
              scaleX: active
                ? Math.min(1, Math.max(0, state.round.progress))
                : 0,
            }}
          />
        </div>
      </div>
      <div className="timeout">
        <span className="eyebrow">ROUND TIMEOUT</span>
        {active && state.round.id === 1 && !state.round.endsBy ? (
          <strong>NO DEADLINE</strong>
        ) : (
          <Timer at={active ? state.round.endsBy : 0} />
        )}
      </div>
    </section>
  );
}
function FeedMeter() {
  const { state } = useGame();
  const active = state.mode === "live" || state.mode === "demo";
  return (
    <Link href="/feed" className="feed-meter panel">
      <div>
        <span className="eyebrow">THE FEED / CURRENT POT</span>
        <strong className="digits">
          {state.updatedAt &&
          active &&
          (state.feed.generatedRoundWei !== null || state.mode === "demo")
            ? eth(state.round.potWei)
            : "—"}{" "}
          <small>ETH</small>
        </strong>
        <p>Creator fees from every official token feed this round.</p>
        <span className="text-link">FOLLOW THE FEED ↗</span>
      </div>
      <Art
        id={
          BigInt(state.round.potWei) > 10n ** 18n
            ? "feed-bag-bulk"
            : "feed-bag-8lb"
        }
      />
    </Link>
  );
}
export function Home() {
  const { state } = useGame();
  return (
    <div className="home">
      <section className="hero">
        <picture>
          <source
            type="image/avif"
            srcSet={[512, 1024, 1920, 2560, 3840]
              .map((w) => assetBase + "/banner-" + w + ".avif " + w + "w")
              .join(",")}
            sizes="(min-width: 1800px) 1800px, (max-width: 500px) 500px, 100vw"
          />
          <img
            className="hero-banner"
            srcSet={[512, 1024, 1920, 2560, 3840]
              .map((w) => assetBase + "/banner-" + w + ".webp " + w + "w")
              .join(",")}
            sizes="(min-width: 1800px) 1800px, (max-width: 500px) 500px, 100vw"
            src={assetBase + "/banner-1920.webp"}
            width="2172"
            height="724"
            alt="CS2 Chickens in a sunlit desert courtyard"
            fetchPriority="high"
          />
        </picture>
        <div className="hero-shade" />
        <div className="hero-caption">
          <span className="eyebrow">THREE FAMILIES. ONE WINNER.</span>
          <h1>
            TRADE. HATCH.
            <br />
            <em>RULE THE COOP.</em>
          </h1>
          <Link className="button primary" href="/inventory">
            OPEN INVENTORY <span>↗</span>
          </Link>
        </div>
        <div className="hero-coordinate">
          SEASON 01 <span>41 VARIANTS / 3 FAMILIES</span>
        </div>
      </section>
      <div className="home-content">
        <RoundHud />
        <div className="home-grid">
          <Race />
          <FeedMeter />
        </div>
        <Participation />
        <div className="section-label spacious">
          <h2>FIELD OPERATIONS</h2>
          <span>EVERY RESULT HAS A RECEIPT</span>
        </div>
        <FamilyHelp />
        <div className="operations">
          <Link href="/incubator" className="operation incubation">
            <div>
              <span className="eyebrow">THE INCUBATOR</span>
              <h2>
                {state.incubator.status === "idle"
                  ? "NEXT UP: A NEW CHICKEN."
                  : state.incubator.status === "incubating"
                    ? "NEXT CHICKEN REVEAL IN"
                    : state.incubator.status === "hatched"
                      ? "AWAITING TOKEN LAUNCH."
                      : "A NEW CHICKEN IS IN PLAY."}
              </h2>
              <p>
                {state.incubator.status === "idle" ? (
                  "Win a round. Unlock the next variant."
                ) : state.incubator.status === "incubating" ? (
                  <Timer at={state.incubator.hatchAt} />
                ) : (
                  "One block. One verifiable result."
                )}
              </p>
              {state.incubator.status === "incubating" && (
                <p>The current round keeps counting trades.</p>
              )}
              <span className="text-link">ENTER THE INCUBATOR ↗</span>
            </div>
            <NestPreview />
          </Link>
          <Link href="/kitchen" className="operation kitchen">
            <div>
              <span className="eyebrow">THE KITCHEN</span>
              <h2>FEEL THE HEAT.</h2>
              <p>Buy. Burn. Verify.</p>
              <span className="text-link">VIEW THE COOKS ↗</span>
            </div>
            <KitchenScene />
          </Link>
        </div>
        <div className="home-grid lower">
          <section className="panel">
            <div className="section-label">
              <h2>LIVE TRADE FEED</h2>
              <span>LAST 20</span>
            </div>
            <div className="killfeed">
              <AnimatePresence initial={false}>
                {state.ticker.slice(0, 20).map((t, i) => (
                  <motion.a
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={t.tx + t.token + i}
                    href={explorer + "/tx/" + t.tx}
                  >
                    <span>{short(t.wallet)}</span>
                    <b className={t.side}>
                      {t.side.toUpperCase()} {t.ethAmount.toFixed(3)} ETH
                    </b>
                    <strong>{t.token.toUpperCase()}</strong>
                  </motion.a>
                ))}
              </AnimatePresence>
              {!state.ticker.length && (
                <Empty
                  title="WAITING FOR THE FIRST SIGNAL"
                  text="Verified trades appear here when the indexer is active."
                />
              )}
            </div>
          </section>
          <section className="panel">
            <div className="section-label">
              <h2>LATEST HATCHES</h2>
              <Link href="/incubator">VIEW ALL ↗</Link>
            </div>
            {state.history.hatches.length ? (
              state.history.hatches
                .slice(-3)
                .reverse()
                .map((h) => (
                  <div className="hatch-row" key={h.round}>
                    <Art id={h.variant} />
                    <div>
                      <strong>{human(h.variant).toUpperCase()}</strong>
                      {h.tokenAddress ? (
                        <>
                          <Copy value={h.tokenAddress} />
                          <Buy address={h.tokenAddress} />
                        </>
                      ) : (
                        <p>Launching on pons…</p>
                      )}
                    </div>
                  </div>
                ))
            ) : (
              <Empty
                title="THE COLLECTION STARTS HERE"
                text={
                  "The first winning family hatches a new variant after " +
                  config.round.incubationSec / 3600 +
                  " hours."
                }
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span className="eyebrow">STANDING BY</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function Buy({ address }: { address: string }) {
  return (
    <a
      className="button buy-button"
      href={"https://www.ponsfamily.com/launchpad/" + address}
      title={"View this token on pons: " + address}
    >
      OPEN PONS ↗
    </a>
  );
}
export function DataTable({
  headings,
  rows,
  empty,
}: {
  headings: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <Empty title="NO RECORDS YET" text={empty} />}
    </div>
  );
}
