"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import { config } from "../../../packages/core/src/index";
import { useGame } from "./data";
import {
  Art,
  Buy,
  Copy,
  DataTable,
  colors,
  eth,
  explorer,
  human,
} from "./game";
import { Explain } from "./help";

const number = (value: number | undefined | null, suffix = "") =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", { maximumSignificantDigits: 6 }) + suffix;

export function TokenDetail({ id }: { id: string }) {
  const { state, prices, delayed } = useGame();
  const base = config.tokens.find((token) => token.id === id);
  const live = state.tokens.find((token) => token.id === id);
  const family = config.families.find(
    (item) => item.id === id || item.variants.includes(id),
  );
  const meta = config.variantMeta[id as keyof typeof config.variantMeta];
  const hatch = state.history.hatches.find((item) => item.variant === id);
  const address = base?.address ?? live?.address;
  const launched = !!address;
  const active = state.mode === "live" || state.mode === "demo";
  const price = live?.priceEth ?? prices[id];
  const title = base?.symbol ?? meta?.displayName ?? human(id).toUpperCase();
  const trades = state.ticker.filter((trade) => trade.token === id);
  const members = family
    ? [
        family.id,
        ...family.variants.filter((variant) =>
          state.tokens.some((token) => token.id === variant),
        ),
      ]
    : [];
  const role =
    id === "chick"
      ? "Long-term holdings. A growing streak."
      : id === "egg"
        ? "The token behind every cook."
        : "One chicken. One family. Every member counts.";
  const metrics = [
    ["PRICE / ETH", number(price, " ETH")],
    ["PRICE / USD", live?.priceUsd == null ? "—" : "$" + number(live.priceUsd)],
    [
      "MARKET CAP / USD",
      live?.marketCapUsd == null ? "—" : "$" + number(live.marketCapUsd),
    ],
    ["HOLDERS", number(live?.holders)],
    [
      "TOKEN VOLUME / THIS ROUND",
      active && live ? number(live.volumeRoundEth, " ETH") : "—",
    ],
    ["GRADUATION", live ? number(live.graduationProgress * 100, "%") : "—"],
  ];
  return (
    <div
      className="page token-page"
      style={
        { "--family": colors[family?.id ?? ""] ?? "#dea34f" } as CSSProperties
      }
    >
      <nav className="token-breadcrumb" aria-label="Breadcrumb">
        <Link href="/inventory">INVENTORY</Link>
        <span>/</span>
        {family && (
          <>
            <Link href={"/inventory/" + family.id}>
              {family.name.toUpperCase()}
            </Link>
            <span>/</span>
          </>
        )}
        <span aria-current="page">{title}</span>
      </nav>
      <section className="token-overview">
        <div className="token-artwork">
          <div className="item-top">
            <span>
              {launched
                ? "OFFICIAL TOKEN"
                : hatch
                  ? "HATCHED · AWAITING LAUNCH"
                  : "NOT YET HATCHED"}
            </span>
            <span>{meta?.rarity ?? "BASE TOKEN"}</span>
          </div>
          <Art id={id} locked={!launched && !hatch} eager />
          <span className="eyebrow">
            {family
              ? family.name.toUpperCase() + " FAMILY"
              : "SEASON 01 / " + id.toUpperCase()}
          </span>
        </div>
        <div className="token-summary">
          <span className="eyebrow">ROBINHOOD CHAIN / TOKEN DOSSIER</span>
          <h1>{title}</h1>
          <p className="eyebrow">TICKER / {base?.symbol ?? meta?.symbol}</p>
          <p className="token-tagline">{role}</p>
          {address ? (
            <>
              <div className="token-contract">
                <span className="eyebrow">OFFICIAL CONTRACT</span>
                <code>{address}</code>
                <Copy value={address} />
              </div>
              <div
                className="token-market-links"
                aria-label="Token market links"
              >
                <Buy address={address} />
                <a
                  className="button"
                  href={
                    "https://gmgn.ai/robinhood/token/" + address.toLowerCase()
                  }
                >
                  GMGN ↗
                </a>
                <a className="button" href={explorer + "/token/" + address}>
                  EXPLORER ↗
                </a>
              </div>
              <p className="token-note">
                External market data may update at a different time. Check the
                contract address on every platform.
              </p>
            </>
          ) : (
            <div className="panel token-pending">
              <h2>
                {hatch ? "REVEALED. NOT TRADABLE YET." : "STILL IN THE EGG."}
              </h2>
              <p>
                {hatch
                  ? "The official contract and market links appear after its launch is verified on-chain."
                  : "This variant must hatch and officially launch before it can be traded or contribute to its family."}
              </p>
              <Link className="text-link" href="/incubator">
                VISIT THE INCUBATOR ↗
              </Link>
            </div>
          )}
        </div>
      </section>
      {launched && (
        <section aria-label="Token statistics" className="token-stats">
          {metrics.map(([label, value]) => (
            <div className="panel" key={label}>
              <span className="eyebrow">{label}</span>
              <strong className="digits">{value}</strong>
            </div>
          ))}
        </section>
      )}
      {launched && (
        <p className="token-note">
          {live
            ? delayed
              ? "Updates delayed. Showing the last published token data."
              : "Latest published token data · indexed block " +
                state.headBlock.toLocaleString("en-US") +
                "."
            : "Published token data is unavailable. Missing figures are shown as —, never assumed to be zero."}{" "}
          {active
            ? "Round " + state.round.id + " volume."
            : "No active round is published."}
        </p>
      )}
      <section className="token-info-grid">
        <article className="panel token-role">
          <span className="eyebrow">KNOW YOUR CHICKEN</span>
          <h2>ITS ROLE IN THE GAME</h2>
          {id === "chick" ? (
            <>
              <p>
                Eligible CHICK holders share 10% of the community pot in a hatch
                round. Your weight combines average holdings over the round with
                your holding streak.
              </p>
              <p>
                Holding from start to finish increases the streak. The
                multiplier grows by 0.5 per consecutive round, up to 3×. A zero
                balance resets it.
              </p>
              <p>
                CHICK volume does not compete in the family race. Fire rounds
                and timeouts do not create CHICK holder payouts.
              </p>
            </>
          ) : id === "egg" ? (
            <>
              <p>
                EGG receives 30% of each hatch-round pot for purchases and
                burns. Timeout rounds cook 100% of their pot; fire rounds also
                allocate funds to EGG.
              </p>
              <p>
                Cooking buys tokens on the market and sends them to the burn
                address. EGG does not compete as a family and holding it alone
                does not create a holder payout.
              </p>
              <Link className="text-link" href="/kitchen">
                SEE VERIFIED COOKS ↗
              </Link>
            </>
          ) : (
            <>
              <p>
                {family?.name}'s original token and every launched variant
                compete together. Buys and sells of any member add to the same
                family total.
              </p>
              <p>
                If this family wins a hatch round, its eligible holders share
                60% of the community pot. Holdings across family members are
                time-weighted and valued at the round's closing prices.
              </p>
              <p>
                There is no requirement to hold the original chicken. Cosmetic
                rarity does not multiply your payout.
              </p>
              <Link className="text-link" href="/rounds">
                FOLLOW THE FAMILY RACE ↗
              </Link>
            </>
          )}
          <Link className="text-link" href="/whitepaper">
            READ THE FULL RULES ↗
          </Link>
        </article>
        <article className="panel token-role">
          <span className="eyebrow">PUBLIC RECORD</span>
          <h2>IDENTITY & PROOF</h2>
          <dl className="token-facts">
            <div>
              <dt>NETWORK</dt>
              <dd>Robinhood Chain · {config.chainId}</dd>
            </div>
            <div>
              <dt>ROLE</dt>
              <dd>
                {family
                  ? family.name +
                    (base ? " · Original chicken" : " · Family variant")
                  : id === "egg"
                    ? "Buy & burn"
                    : "Holding streak"}
              </dd>
            </div>
            <div>
              <dt>STATUS</dt>
              <dd>
                {launched
                  ? "Launched"
                  : hatch
                    ? "Hatched, awaiting official launch"
                    : "Locked"}
              </dd>
            </div>
            {id === "egg" && (
              <div>
                <dt>COOK DESTINATION</dt>
                <dd>
                  <a href={explorer + "/address/" + config.wallets.burn}>
                    {config.wallets.burn} ↗
                  </a>
                </dd>
              </div>
            )}
            {hatch && (
              <div>
                <dt>HATCH ROUND</dt>
                <dd>
                  {hatch.round} ·{" "}
                  <a href={explorer + "/block/" + hatch.block}>
                    Verify block {hatch.block} ↗
                  </a>
                </dd>
              </div>
            )}
            {base && (
              <div>
                <dt>LAUNCH BLOCK</dt>
                <dd>
                  <a
                    href={
                      explorer +
                      "/block/" +
                      config.tokenLaunchBlocks[
                        base.id as keyof typeof config.tokenLaunchBlocks
                      ]
                    }
                  >
                    {
                      config.tokenLaunchBlocks[
                        base.id as keyof typeof config.tokenLaunchBlocks
                      ]
                    }{" "}
                    ↗
                  </a>
                </dd>
              </div>
            )}
            {family && active && (
              <div>
                <dt>FAMILY VOLUME / ROUND {state.round.id}</dt>
                <dd>
                  {state.round.volumeByFamily[family.id] === undefined
                    ? "—"
                    : eth(state.round.volumeByFamily[family.id]) + " ETH"}
                </dd>
              </div>
            )}
          </dl>
          {config.socials.x && (
            <a className="text-link" href={config.socials.x}>
              FOLLOW @CS2CHICKENS ON X ↗
            </a>
          )}
        </article>
      </section>
      {family && (
        <section className="token-family">
          <div className="section-label">
            <h2>THE SAME FAMILY. THE SAME SCORE.</h2>
            <Link href={"/inventory/" + family.id}>FULL COLLECTION ↗</Link>
          </div>
          <div className="token-siblings">
            {members.map((member) => (
              <Link
                href={"/tokens/" + member}
                key={member}
                aria-current={member === id ? "page" : undefined}
              >
                <Art id={member} />
                <span>{human(member).toUpperCase()}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {launched && (
        <section className="token-trades">
          <div className="section-label">
            <h2>RECENT INDEXED TRADES</h2>
            <span>{trades.length} IN THE LATEST FEED</span>
          </div>
          <p className="token-note">
            Matching trades from the latest 20 project-wide events. This is not
            the full trading history; use the market links for charts and older
            activity.
          </p>
          <DataTable
            headings={["SIDE", "VOLUME", "TRANSACTION"]}
            rows={trades.map((trade) => [
              trade.side.toUpperCase(),
              number(trade.ethAmount, " ETH"),
              <a href={explorer + "/tx/" + trade.tx} key={trade.tx}>
                VERIFY TRADE ↗
              </a>,
            ])}
            empty="No trades for this token in the latest published feed."
          />
        </section>
      )}
      <Explain title="Why can these numbers differ from a trading platform?">
        <p>
          The site uses confirmed, indexed chain data. Market platforms can
          update sooner or use different price and supply calculations.
          Graduation shows progress from the Pons bonding curve toward its
          market pool.
        </p>
        <p>
          Trading volume decides the family winner; it is not your personal
          reward weight. Check your own eligible holdings and payout receipts on
          the wallet page.
        </p>
        <Link href="/check">CHECK YOUR WALLET ↗</Link>
      </Explain>
    </div>
  );
}
