"use client";
import Link from "next/link";
import { formatEther } from "viem";
import { config } from "../../../packages/core/src/index";
import type { WalletLedger } from "../../../packages/core/src/state";
import { dataBase } from "./data";
import { Explain } from "./help";
import styles from "./wallet-rewards.module.css";

export function WalletRewards({ ledger }: { ledger: WalletLedger }) {
  const rewards = ledger.pendingRewards;
  const ready = rewards?.ready === true && rewards.totalWei !== null;
  return (
    <section
      className={styles.panel}
      aria-label="Published rewards awaiting payment"
    >
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">PUBLISHED HOLDER REWARDS</span>
          <h3>AWAITING PAYMENT</h3>
        </div>
        <span className={styles.status}>OPERATOR PAYMENT</span>
      </div>
      <strong className={styles.total} data-testid="pending-reward-total">
        {ready
          ? formatEther(BigInt(rewards!.totalWei!)) + " ETH"
          : "NOT YET VERIFIED"}
      </strong>
      <p className={styles.description}>
        {ready
          ? rewards!.count === 0
            ? "No published holder payment is awaiting confirmation for this address in this record."
            : "Published for this address and awaiting a verified payment receipt. The operator sends these payments; no claim transaction or wallet connection is required here."
          : "Pending rewards are still being indexed. An unavailable total does not mean zero rewards."}
      </p>
      {rewards && rewards.latest.length > 0 && (
        <>
          {rewards.hasMore && (
            <p className="muted">
              Showing the latest 100 entries
              {rewards.count !== null ? ` of ${rewards.count}` : ""}.{" "}
              {ready
                ? "The verified total includes every published payment still awaiting confirmation."
                : "The total is still being indexed."}{" "}
              Earlier rounds remain available in the full payout plans.
            </p>
          )}
          <ul className={styles.rows} aria-label="Published payment entries">
            {rewards.latest.map((row) => (
              <li key={`${row.round}:${row.category}`}>
                <dl className={styles.fields}>
                  <div>
                    <dt>ROUND</dt>
                    <dd>{row.round}</dd>
                  </div>
                  <div>
                    <dt>REWARD</dt>
                    <dd>
                      {row.category === "family"
                        ? "WINNING FAMILY"
                        : "CHICK HOLDERS"}
                    </dd>
                  </div>
                  <div className={styles.amountField}>
                    <dt>ETH AWAITING PAYMENT</dt>
                    <dd
                      className={styles.amount}
                      data-testid="pending-entry-amount"
                    >
                      {formatEther(BigInt(row.amountWei))}
                    </dd>
                  </div>
                  <div className={styles.planField}>
                    <dt>PAYOUT PLAN</dt>
                    <dd>
                      <a
                        className={styles.plan}
                        href={`${dataBase}/payouts/${row.round}.json`}
                      >
                        ROUND {row.round} PLAN ↗
                      </a>
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
      <Explain title="Published payments, carry-over and live weights: what is the difference?">
        <p>
          Published rewards come from completed rounds whose payout plans are
          ready. Prepared calculations, current-round estimates, carry-over and
          confirmed payments are excluded from this total. A payment stays
          pending until its confirmed transaction receipt is verified by the
          indexer.
        </p>
        <p>
          Carry-over is kept separately below. Amounts that remain below the
          payout cutoff after {config.payouts.carryoverRounds} rounds are
          redirected to EGG cooks under the published rules. Waiting for the
          operator to send an already published payment does not apply that
          carry-over expiry to it.
        </p>
        <p>
          Live holding weights describe participation in the current round. They
          are not a promised or claimable reward.
        </p>
      </Explain>
      <Link className={styles.allPlans} href="/feed/">
        ALL PAYOUT PLANS ↗
      </Link>
    </section>
  );
}
