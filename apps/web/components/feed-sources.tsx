"use client";

import Link from "next/link";
import { formatEther } from "viem";
import { config, bps, BPS } from "../../../packages/core/src/index";
import { useGame } from "./data";
import { Art, eth, human } from "./game";
import { Explain } from "./help";

function Amount({ value }: { value: string | bigint | null }) {
  if (value === null) return <strong className="digits">—</strong>;
  const wei = BigInt(value);
  return (
    <strong className="digits" title={formatEther(wei) + " ETH"}>
      {wei > 0n && wei < 100000000000000n ? "<0.0001" : eth(wei)}
      <small> ETH</small>
    </strong>
  );
}

export function FeedSources() {
  const { state, delayed } = useGame();
  const sources = state.feed.sources;
  const ready = sources?.ready === true;
  const active = state.mode === "live" || state.mode === "demo";
  const listed = [
    ...config.tokens.map((token) => token.id),
    ...state.tokens
      .map((token) => token.id)
      .filter((id) => !config.tokens.some((token) => token.id === id)),
  ];
  const totalVolume = ready
    ? sources.totals.reduce((sum, row) => sum + BigInt(row.volumeWei), 0n)
    : null;
  const supportVolume = ready
    ? sources.totals
        .filter((row) => row.token === "egg" || row.token === "chick")
        .reduce((sum, row) => sum + BigInt(row.volumeWei), 0n)
    : null;
  const reserved = state.feed.preStartCreatorFeeWei;
  return (
    <section
      className="feed-sources panel"
      aria-labelledby="feed-sources-title"
    >
      <div className="section-label">
        <h2 id="feed-sources-title">EVERY TOKEN FILLS THE FEED</h2>
        <span>
          {!ready
            ? "TOTALS BEING VERIFIED"
            : delayed
              ? "INDEXED HISTORY · CATCHING UP"
              : "VERIFIED ON-CHAIN"}
        </span>
      </div>
      <p className="feed-sources-intro">
        EGG, CHICK and every family token generate fees for the same pot. Half
        of verified creator fees funds community rewards and buybacks and burns.
        EGG and CHICK support the pot without competing for the family win or
        advancing the round's volume quota.
      </p>
      <div className="source-summary">
        <div>
          <span className="eyebrow">ALL TOKENS · INDEXED VOLUME</span>
          <Amount value={totalVolume} />
        </div>
        <div>
          <span className="eyebrow">EGG + CHICK · INDEXED VOLUME</span>
          <Amount value={supportVolume} />
        </div>
      </div>
      <div className="source-list">
        {listed.map((id) => {
          const row = ready
            ? sources.totals.find((entry) => entry.token === id)
            : undefined;
          const support = id === "egg" || id === "chick";
          return (
            <article
              className={"source-token" + (support ? " source-support" : "")}
              key={id}
            >
              <Link className="source-token-name" href={"/tokens/" + id + "/"}>
                <Art id={id} />
                <div>
                  <h3>
                    {human(id).toUpperCase()} <span aria-hidden="true">↗</span>
                  </h3>
                  <span className="eyebrow">
                    {support ? "FUNDS THE FEED" : "FAMILY RACE + FEED"}
                  </span>
                </div>
              </Link>
              <dl>
                <div>
                  <dt>INDEXED VOLUME</dt>
                  <dd>
                    <Amount value={row?.volumeWei ?? null} />
                  </dd>
                </div>
                <div>
                  <dt>THIS ROUND · VOLUME</dt>
                  <dd>
                    <Amount
                      value={
                        active ? (state.round.volumeByToken[id] ?? "0") : null
                      }
                    />
                  </dd>
                </div>
                <div>
                  <dt>CREATOR FEES GENERATED</dt>
                  <dd>
                    <Amount value={row?.creatorFeeWei ?? null} />
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
      <p className="muted source-coverage">
        {ready && sources.throughBlock !== null
          ? `Cumulative figures cover blocks ${sources.fromBlock.toLocaleString("en-US")}–${sources.throughBlock.toLocaleString("en-US")}.`
          : "The per-token totals are being verified. Unavailable values do not mean zero."}{" "}
        {delayed &&
          "Historical catch-up is in progress; newer trades may not appear yet. "}
        Generated fees are before the 50/50 allocation, not completed payments.
      </p>
      {state.mode === "monitoring" && state.round.id === 1 && (
        <div className="source-reserve">
          <div>
            <span className="eyebrow">COMMUNITY FEES RESERVED FOR ROUND 1</span>
            <Amount
              value={
                reserved == null
                  ? null
                  : (BigInt(reserved) *
                      bps(config.fees.feedShareOfCreatorFee)) /
                    BPS
              }
            />
          </div>
          <p>
            EGG and CHICK can generate fees before the race starts. Their
            verified creator fees are reserved for round 1. The first family
            trade starts the race; the reserve is counted once in its pot.
          </p>
        </div>
      )}
      <Explain title="Does buying EGG count even though it is outside the family race?">
        <p>
          Yes. EGG and CHICK trading volume is recorded here, and their verified
          creator fees help fund the community pot just like family-token fees.
          Only family-token volume advances the 100 ETH opening quota and
          decides the winning family.
        </p>
        <p>
          Volume is the value traded, not the amount distributed. The allocation
          uses actual creator fees verified from the contracts, not a fixed
          percentage multiplied by volume. Trading EGG does not itself create a
          direct holder reward; EGG benefits through the buyback-and-burn
          allocation.
        </p>
      </Explain>
    </section>
  );
}
