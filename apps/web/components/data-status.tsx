"use client";
import { LinkArrow } from "./link-arrow";

import Link from "next/link";
import { config } from "../../../packages/core/src/index";
import { useGame, dataBase } from "./data";
import { Title, explorer, Copy } from "./game";
import styles from "./data-status.module.css";

function utc(timestamp: number) {
  return new Date(timestamp * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
}
export function DataStatus() {
  const { state, delayed, connection, refresh } = useGame();
  const known = state.updatedAt > 0,
    collection = state.feed.collection;
  const fresh = known && !delayed;
  const coverage =
    known &&
    collection?.throughBlock === state.headBlock &&
    collection.status !== "backfilling";
  const mode =
    state.mode === "demo"
      ? "LOCAL SIMULATION"
      : state.mode === "live"
        ? "ROUNDS ACTIVE"
        : state.mode === "monitoring"
          ? "MARKETS ONLY"
          : "AWAITING ACTIVATION";
  return (
    <div className="page">
      <Title
        eyebrow="PUBLIC VERIFICATION / NO WALLET CONNECTION"
        title="DATA & PAYMENTS"
        detail="Know what is current, what is still being calculated and what has actually been paid."
      />
      <section className={styles.summary} aria-label="Public data status">
        <div>
          <span className="eyebrow">PUBLISHED SNAPSHOT</span>
          <h2>
            {!known
              ? connection === "loading"
                ? "CONNECTING…"
                : "DATA UNAVAILABLE"
              : fresh
                ? "DATA UP TO DATE"
                : "LAST VERIFIED RECORD"}
          </h2>
          <p>
            {known
              ? `Published ${utc(state.updatedAt)}. ${delayed ? "Updates are delayed or being checked; this is not a current balance guarantee." : "The data reflects confirmed, indexed blocks and can lag the chain tip."}`
              : "Amounts and activity are unknown until a verified snapshot is available. Missing data does not mean zero activity."}
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          onClick={refresh}
          disabled={connection === "loading"}
        >
          {connection === "loading" ? "CHECKING…" : "REFRESH NOW"}
        </button>
        {known && (
          <div className={styles.source}>
            <span>{mode}</span>
            <a href={explorer + "/block/" + state.headBlock}>
              INDEXED BLOCK {state.headBlock.toLocaleString("en-US")}{" "}
              <LinkArrow />
            </a>
            <a href={dataBase + "/state.json"}>
              VIEW PUBLIC SNAPSHOT <LinkArrow />
            </a>
          </div>
        )}
      </section>
      <div className={styles.grid}>
        <section className={styles.card}>
          <span className="eyebrow">01 / THE COMPETITION</span>
          <h2>
            {!known
              ? "ROUND STATE UNKNOWN"
              : delayed
                ? "ROUND DATA DELAYED"
                : mode}
          </h2>
          <p>
            Confirmed family trades move the score. Rounds keep running while
            earlier eggs incubate. A displayed countdown is a reveal time, not
            proof that a new token has launched.
          </p>
          <Link href="/rounds">
            FOLLOW THE ROUND <LinkArrow />
          </Link>
        </section>
        <section className={styles.card}>
          <span className="eyebrow">02 / HOLDER ALLOCATIONS</span>
          <h2>
            {!known
              ? "NOT AVAILABLE"
              : !state.feed.accountingReady
                ? "CALCULATIONS CATCHING UP"
                : delayed
                  ? "LAST PUBLISHED TOTALS"
                  : "PUBLISHED TOTALS RECONCILED"}
          </h2>
          <p>
            Weights during a round are provisional. A published payout list
            records the calculated allocation; the payment is confirmed only
            after a verified transaction. Hatch rounds, fire rounds and timeouts
            follow different rules.
          </p>
          <Link href="/check">
            CHECK MY PAYMENTS <LinkArrow />
          </Link>
        </section>
        <section className={styles.card}>
          <span className="eyebrow">03 / COLLECTED FEES</span>
          <h2>
            {!coverage
              ? !known
                ? "RECEIPTS UNAVAILABLE"
                : "RECEIPTS CATCHING UP"
              : collection?.status === "ambiguous"
                ? "MIXED CREDITS · BOUNDED TOTAL"
                : delayed
                  ? "LAST VERIFIED COVERAGE"
                  : "COLLECTION RECONCILED"}
          </h2>
          <p>
            {coverage
              ? `Collection receipts cover blocks ${collection!.fromBlock.toLocaleString("en-US")}–${collection!.throughBlock!.toLocaleString("en-US")}. `
              : "The collected total stays unavailable until receipt coverage reaches the published block. "}
            Generated fees, available escrow funds and collected funds are
            separate amounts. Unrelated escrow credits can make a partial
            withdrawal's attribution ambiguous.
          </p>
          <Link href="/feed">
            SEE THE FEE BREAKDOWN <LinkArrow />
          </Link>
        </section>
        <section className={styles.card}>
          <span className="eyebrow">04 / ACTUAL PAYMENTS</span>
          <h2>
            {config.wallets.split && config.wallets.multisend
              ? "OPERATOR CONFIRMATIONS"
              : "CONTRACT SETUP PENDING"}
          </h2>
          <p>
            The operator signs distributions and cooks. This public site cannot
            send funds. A fresh market update does not prove a completed payout,
            and incubation does not set a payment deadline.
          </p>
          <Link href="/feed">
            VIEW SETTLEMENT RECEIPTS <LinkArrow />
          </Link>
        </section>
      </div>
      <section
        className={styles.contracts}
        aria-label="Published settlement addresses"
      >
        <h2>CHECK THE DESTINATIONS</h2>
        <p>
          These are the addresses listed in the project's public configuration.
          Their presence here is not a new contract audit or proof of
          deployment.
        </p>
        {[
          ["Collection / community Feed", config.wallets.feed],
          ["Developer share", config.wallets.dev],
          ["Split contract", config.wallets.split],
          ["Multisend contract", config.wallets.multisend],
        ].map(([label, address]) => (
          <div key={label}>
            <strong>{label}</strong>
            {address ? (
              <>
                <Copy value={address} />
                <a href={explorer + "/address/" + address}>
                  EXPLORER <LinkArrow />
                </a>
              </>
            ) : (
              <span>AWAITING DEPLOYMENT</span>
            )}
          </div>
        ))}
      </section>
      <p className={styles.note}>
        This page describes published data, not uptime of every underlying
        service. <Link href="/verify">Verify a token address</Link> before
        following a trading link. Your wallet's private keys and recovery phrase
        are never needed here.
      </p>
    </div>
  );
}
