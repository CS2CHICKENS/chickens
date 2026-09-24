"use client";
import { LinkArrow } from "./link-arrow";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { KitchenScene } from "./scenes";
import { FamilyBattle } from "./battle";
import { Explain } from "./help";
import { FeeFlow } from "./fee-flow";
import { FeedSources } from "./feed-sources";
import { ArchivePicker, useArchive } from "./history";
import { WalletRewards } from "./wallet-rewards";
import { formatEther, isAddress, type Address } from "viem";
import { config } from "../../../packages/core/src/index";
import {
  walletLedgerSchema,
  type WalletLedger,
} from "../../../packages/core/src/state";
import { client, tokenAbi } from "../../../packages/core/src/chain";
import { useGame, assetBase, dataBase } from "./data";
import {
  Title,
  Art,
  Copy,
  DataTable,
  eth,
  short,
  human,
  colors,
  explorer,
} from "./game";
export function Rounds() {
  const { state } = useGame();
  const history = useArchive(
    state.history.rounds,
    state.history.pages,
    "rounds",
  );
  return (
    <div className="page">
      <Title
        eyebrow="LIVE COMPETITION / SEASON 01"
        title="THE ROUNDS"
        detail="Three families. All their chickens. One combined score per family."
      />
      <FamilyBattle />
      <div className="section-label spacious">
        <h2>PAST ROUNDS</h2>
        <span>FINISHED ROUNDS ONLY</span>
      </div>
      <div className="hall">
        {config.families.map((f) => (
          <div key={f.id} style={{ "--family": colors[f.id] } as CSSProperties}>
            <Art id={f.id} />
            <div>
              <span className="eyebrow">{f.name.toUpperCase()}</span>
              <strong className="digits">
                {(
                  state.history.wins?.[f.id] ??
                  state.history.rounds.filter((r) => r.winner === f.id).length
                )
                  .toString()
                  .padStart(2, "0")}
              </strong>
              <span>ROUNDS WON</span>
            </div>
          </div>
        ))}
      </div>
      <ArchivePicker view={history} label="Round archive" />
      <DataTable
        headings={["ROUND", "WINNER", "POT / ETH", "END REASON", "END BLOCK"]}
        rows={history.rows.map((r) => [
          String(r.id),
          r.winner?.toUpperCase() || "NO WINNER",
          r.accountingVerified || state.mode === "demo"
            ? eth(r.potWei)
            : "NOT VERIFIED",
          r.endReason,
          <a key="block" href={explorer + "/block/" + r.endBlock}>
            {r.endBlock} <LinkArrow />
          </a>,
        ])}
        empty={
          history.busy
            ? "Loading round archive…"
            : history.error
              ? "Round records could not be loaded."
              : "The first round has yet to end."
        }
      />
    </div>
  );
}
export function Kitchen() {
  const { state } = useGame();
  const known = state.updatedAt > 0 && state.mode !== "unconfigured";
  return (
    <div className="page">
      <Title
        eyebrow="SUPPLY REDUCTION / PUBLIC RECEIPTS"
        title="THE KITCHEN"
        detail="Some eggs never hatch. They get cooked."
      />
      <Explain title="What does cooking an egg actually do?">
        <p>
          Cooking means buying EGG on the market and sending it to the burn
          address. The animation is a visual preview; only the transactions in
          the cook log count as completed buys and burns.
        </p>
        <p>
          The cook destination is{" "}
          <a href={explorer + "/address/" + config.wallets.burn}>
            {config.wallets.burn}
          </a>
          . Tokens at this conventional dead address are treated as out of
          circulation. Transfers there do not change the contract's totalSupply.
          The supply figure below subtracts its balance from that on-chain
          total.
        </p>
        <p>
          Buys are spread across smaller transactions over about an hour after
          the operator starts settlement. Round closure alone does not start a
          buy or guarantee its execution time. This page records those receipts,
          rather than treating an animation as proof of a burn.
        </p>
      </Explain>
      <section className="kitchen-hero">
        <div>
          <span className="eyebrow">TOTAL EGG BURNED</span>
          <strong className="digits">
            {known ? eth(state.kitchen.eggBurnedTotal, 0) : "—"}
          </strong>
          <p>OUT OF CIRCULATION. FOR GOOD.</p>
          <span className="eyebrow">SUPPLY OUTSIDE THE BURN ADDRESS</span>
          <p className="digits">
            {known && state.kitchen.supplyLeftWei !== null
              ? eth(state.kitchen.supplyLeftWei, 0)
              : "—"}{" "}
            EGG
          </p>
        </div>
        <KitchenScene animate />
      </section>
      <div className="section-label spacious">
        <h2>LATEST COOKS</h2>
        <span>SMALL BUYS. PUBLIC BURNS.</span>
      </div>
      <p className="muted">
        The latest 100 completed cooks are shown.{" "}
        <a
          href={
            explorer +
            "/address/" +
            config.wallets.burn +
            "?tab=token_transfers"
          }
        >
          Browse all transfers to the burn address <LinkArrow />
        </a>
      </p>
      <DataTable
        headings={["ROUND", "TOKEN", "ETH IN", "TOKENS BURNED", "TRANSACTION"]}
        rows={state.kitchen.lastCooks.map((c) => [
          String(c.round),
          c.token.toUpperCase(),
          eth(c.ethIn),
          eth(c.tokensBurned, 0),
          <a key="tx" href={explorer + "/tx/" + c.tx}>
            {short(c.tx)} <LinkArrow />
          </a>,
        ])}
        empty="Completed buys and burns will appear after the first round."
      />
      <div className="split-explainer">
        <div>
          <strong>30%</strong>
          <span>HATCH ROUND → EGG</span>
        </div>
        <div>
          <strong>100%</strong>
          <span>TIMEOUT → EGG</span>
        </div>
        <div>
          <strong>100%</strong>
          <span>FIRE ROUND → TOKEN BURNS</span>
        </div>
      </div>
    </div>
  );
}
export function Feed() {
  const { state } = useGame();
  const history = useArchive(
    state.history.rounds,
    state.history.pages,
    "rounds",
  );
  const known = state.updatedAt > 0 && state.mode !== "unconfigured";
  const active = state.mode === "live" || state.mode === "demo";
  const settlementLabels = {
    pending: "AWAITING CALCULATION",
    published: "AWAITING SETTLEMENT",
    partial: "SETTLEMENT IN PROGRESS",
    distributed: "SETTLEMENT CONFIRMED",
  };
  return (
    <div className="page">
      <Title
        eyebrow="THE PUBLIC POT / EVERY WEI ACCOUNTED FOR"
        title="THE FEED"
        detail="Every official token fills the bag. EGG and CHICK included."
      />
      <FeedSources />
      <section className="fee-collection">
        <h3>FEE COLLECTION WALLET</h3>
        <p>
          This wallet receives 100% of creator fees before allocation: 50% to
          the developer, 50% to community distribution and buybacks and burns.
          The same address receives the community half back from Split. Its
          balance can also include unallocated funds and gas reserves.
        </p>
        <Copy value={config.fees.collectionWallet} />
        <a
          className="text-link"
          href={explorer + "/address/" + config.fees.collectionWallet}
        >
          VIEW COLLECTION TRANSACTIONS <LinkArrow />
        </a>
      </section>
      <FeeFlow />
      <section
        className="fee-accounting panel"
        aria-label="Verified creator fee accounting"
      >
        <div className="section-label">
          <h2>CREATOR FEE ACCOUNTING</h2>
          <span>VERIFIED AMOUNTS · DIFFERENT STAGES</span>
        </div>
        <p>
          Generated and collected totals cover indexed official-token creator
          fees before the 50/50 allocation. Escrow claimable is the current
          balance available to the collection wallet and can include other
          credits. These measures have different coverage; do not add them
          together.
        </p>
        <div className="accounting-grid">
          {[
            [
              "GENERATED · CUMULATIVE",
              state.feed.generatedWei,
              "Verified creator fees recognized in ETH.",
            ],
            [
              "ESCROW CLAIMABLE",
              state.feed.claimableWei,
              "Escrow balance for the collection wallet, not assigned to a specific round. Excludes fees still awaiting sweep or conversion.",
            ],
            [
              "COLLECTED · CUMULATIVE",
              state.feed.collectedWei,
              "Official-token fees received by the collection wallet, before the 50/50 split. Unrelated escrow credits are excluded.",
            ],
          ].map(([label, value, description]) => (
            <div key={label}>
              <span className="eyebrow">{label}</span>
              <strong className="digits">
                {known && value !== null
                  ? formatEther(BigInt(value)) + " ETH"
                  : "NOT INDEXED"}
              </strong>
              <p>{description}</p>
            </div>
          ))}
        </div>
        <p className="muted">
          {state.feed.feeAccountingStartBlock !== null
            ? "Generated fee accounting starts at block " +
              state.feed.feeAccountingStartBlock.toLocaleString("en-US") +
              "."
            : "The accounting coverage has not yet been verified."}{" "}
          Unavailable values do not mean zero fees.
        </p>
        <p className="muted">
          {state.feed.collection?.status === "verified"
            ? `Collection receipts verified from block ${state.feed.collection.fromBlock} through ${state.feed.collection.throughBlock}.`
            : state.feed.collection?.status === "ambiguous" &&
                state.feed.collection.lowerBoundWei !== null &&
                state.feed.collection.upperBoundWei !== null
              ? `Collection receipts verified through block ${state.feed.collection.throughBlock}. Mixed escrow credits prevent an exact attribution: between ${formatEther(BigInt(state.feed.collection.lowerBoundWei))} and ${formatEther(BigInt(state.feed.collection.upperBoundWei))} ETH is attributable to project fees. No arbitrary allocation is presented as fact.`
              : "Collection receipts are being indexed. The collected total will appear once their coverage catches up with the indexed chain."}
        </p>
      </section>
      <section className="feed-overview panel">
        <Art id="feed-bag-bulk" />
        <div>
          <span className="eyebrow">FEED WALLET BALANCE</span>
          <strong className="digits">
            {known && (config.wallets.feed || state.mode === "demo")
              ? eth(state.feed.balanceWei)
              : "—"}{" "}
            <small>ETH</small>
          </strong>
          {config.wallets.feed ? (
            <Copy value={config.wallets.feed} />
          ) : (
            <p>Feed wallet will be published before activation.</p>
          )}
          <div className="feed-stats">
            {[
              ["CURRENT ROUND CREATOR FEES", state.feed.generatedRoundWei],
              ["PUBLISHED PAYOUTS OWED", state.feed.owedWei],
              ["CURRENT ROUND POT", state.feed.accruingWei],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong className="digits">
                  {known &&
                  active &&
                  (label !== "PUBLISHED PAYOUTS OWED" ||
                    state.feed.accountingReady) &&
                  value !== null &&
                  (label !== "CURRENT ROUND POT" ||
                    state.feed.generatedRoundWei !== null ||
                    state.mode === "demo")
                    ? eth(value, 8)
                    : "—"}{" "}
                  ETH
                </strong>
              </div>
            ))}
          </div>
        </div>
      </section>
      <p className="split-caption">HATCH ROUND · SHARE OF THE COMMUNITY POT</p>
      <div className="split-explainer">
        <div>
          <strong>60%</strong>
          <span>WINNING FAMILY</span>
        </div>
        <div>
          <strong>30%</strong>
          <span>EGG COOK</span>
        </div>
        <div>
          <strong>10%</strong>
          <span>CHICK HOLDERS</span>
        </div>
      </div>
      <section className="developer-share panel">
        <div>
          <span className="eyebrow">DEVELOPER FEES PAID · CUMULATIVE</span>
          <strong className="digits">
            {known &&
            state.feed.accountingReady &&
            state.feed.developerSource !== "unavailable"
              ? eth(state.feed.devWithdrawnWei) + " ETH"
              : "NOT INDEXED"}
          </strong>
        </div>
        <p>
          The developer’s published 50% share of creator fees. This counter
          covers indexed split-contract releases only; it does not claim to
          include direct transfers from the fee collection wallet.
        </p>
        <p>
          Reporting stops at payment to the developer. This is not a personal
          wallet balance, and onward transfers are not included in this report.
        </p>
        {config.wallets.dev && (
          <div>
            <span className="eyebrow">DEVELOPER PAYMENT DESTINATION</span>
            <Copy value={config.wallets.dev} />
          </div>
        )}
        {config.wallets.split ? (
          <a
            className="text-link"
            href={explorer + "/address/" + config.wallets.split}
          >
            VERIFY THE SPLIT CONTRACT <LinkArrow />
          </a>
        ) : (
          <span className="muted">
            Split contract awaiting deployment. Collection-wallet transfers can
            be checked on the explorer above.
          </span>
        )}
      </section>
      <div className="section-label spacious">
        <h2>PAYOUT MANIFESTS</h2>
        <span>CANONICAL LIST + HASH</span>
      </div>
      <ArchivePicker view={history} label="Payout archive" />
      <DataTable
        headings={[
          "ROUND",
          "POT",
          "ROUND SETTLEMENT",
          "MANIFEST HASH",
          "LIST",
          "PAYMENT RECEIPTS",
        ]}
        rows={history.rows.map((r) => [
          String(r.id),
          r.accountingVerified || state.mode === "demo"
            ? eth(r.potWei) + " ETH"
            : "NOT VERIFIED",
          settlementLabels[r.settlementStatus],
          <span className="hash" key="hash">
            {r.payoutHash || "NOT PUBLISHED"}
          </span>,
          r.payoutHash ? (
            <a key="list" href={dataBase + "/payouts/" + r.id + ".json"}>
              DOWNLOAD <LinkArrow />
            </a>
          ) : (
            "—"
          ),
          r.payoutTransactions.length ? (
            <div key="receipts" className="receipt-links">
              {r.payoutTransactions.map((tx, index) => (
                <a key={tx} href={explorer + "/tx/" + tx}>
                  BATCH {index + 1} · {short(tx)} <LinkArrow />
                </a>
              ))}
              {r.payoutTransactionsHasMore && (
                <p className="muted">
                  First 100 transactions shown.{" "}
                  <Link href="/check/">
                    Check your wallet for your complete payment history{" "}
                    <LinkArrow />
                  </Link>
                </p>
              )}
            </div>
          ) : (
            "NO CONFIRMED PAYMENTS"
          ),
        ])}
        empty={
          history.busy
            ? "Loading payout archive…"
            : history.error
              ? "Payout records could not be loaded."
              : "No payout list has been published. Below-minimum rewards carry forward for up to three rounds."
        }
      />
      <p className="muted">
        Balances and transactions are indexed from the chain. A computed pot is
        not a guarantee of available funds.
      </p>
    </div>
  );
}

export function Check() {
  const { state } = useGame();
  const [address, setAddress] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{
      address: string;
      holdings: { id: string; balance: string | null }[];
      ledger: WalletLedger | null;
      ledgerUnavailable: boolean;
      registryUnavailable: boolean;
    } | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setResult(null);
    if (!isAddress(address)) {
      setError("Enter a valid 0x wallet address.");
      return;
    }
    setBusy(true);
    const wallet = address as Address;
    const official = [
      ...config.tokens,
      ...state.tokens.filter(
        (token) => !config.tokens.some((base) => base.id === token.id),
      ),
    ];
    try {
      const rpc = client();
      const balances = await Promise.allSettled(
        official.map(async (token) => ({
          id: token.id,
          balance: formatEther(
            await rpc.readContract({
              address: token.address as Address,
              abi: tokenAbi,
              functionName: "balanceOf",
              args: [wallet],
            }),
          ),
        })),
      );
      const holdings = balances.map((row, index) =>
        row.status === "fulfilled"
          ? row.value
          : { id: official[index].id, balance: null },
      );
      let ledger: WalletLedger | null = null;
      let ledgerUnavailable = false;
      try {
        const response = await fetch(
          dataBase + "/wallets/" + wallet.toLowerCase() + ".json",
          { signal: AbortSignal.timeout(10000) },
        );
        if (response.ok) {
          ledger = walletLedgerSchema.parse(await response.json());
          if (ledger.address.toLowerCase() !== wallet.toLowerCase())
            throw Error();
        } else if (response.status !== 404) throw Error();
      } catch {
        ledger = null;
        ledgerUnavailable = true;
      }
      setResult({
        address: wallet,
        holdings,
        ledger,
        ledgerUnavailable,
        registryUnavailable:
          state.updatedAt === 0 || state.mode === "unconfigured",
      });
      if (holdings.some((holding) => holding.balance === null))
        setError(
          "Some balances could not be verified. Unavailable amounts are not zero; check again to retry.",
        );
    } catch {
      setError("Chain data is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page wallet-page">
      <Title
        eyebrow="RECON / NO WALLET CONNECTION"
        title="CHECK YOUR WALLET"
        detail="Your holdings. Your streak. Your share of the round."
      />
      <Explain title="Why can my holdings differ from my reward weight?">
        <p>
          Your balance now is a snapshot. Reward weight uses your average
          eligible holdings over the whole round, valued at closing prices.
          CHICK also applies a multiplier for consecutive full rounds held. A
          late purchase does not count as if it had been held since the start.
        </p>
        <p>
          Live weights are provisional until the round ends and eligibility
          checks finish. They are not a confirmed payment.
        </p>
      </Explain>
      <form onSubmit={submit} className="wallet-form panel">
        <label htmlFor="wallet">PUBLIC WALLET ADDRESS</label>
        <div>
          <input
            id="wallet"
            value={address}
            onChange={(event) => setAddress(event.target.value.trim())}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="0x…"
            autoComplete="off"
          />
          <button className="button primary" disabled={busy}>
            {busy ? (
              "SCANNING…"
            ) : (
              <>
                CHECK WALLET <LinkArrow />
              </>
            )}
          </button>
        </div>
        <p>Read-only. No signature. No connection.</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
      {result ? (
        <>
          <div className="section-label spacious">
            <h2>VERIFIED BALANCES</h2>
            <Copy value={result.address} />
          </div>
          {result.registryUnavailable && (
            <p className="muted">
              The live token registry is unavailable. Only the five original
              token addresses can be checked right now.
            </p>
          )}
          <DataTable
            headings={["TOKEN", "BALANCE"]}
            rows={result.holdings.map((holding) => [
              human(holding.id).toUpperCase(),
              <span className="wallet-amount" key="balance">
                {holding.balance ?? "UNAVAILABLE"}
              </span>,
            ])}
            empty="No verified holdings available."
          />
          <section className="panel wallet-ledger">
            <h2>ROUND LEDGER</h2>
            {result.ledger ? (
              <WalletLedgerView ledger={result.ledger} />
            ) : (
              <p>
                {result.ledgerUnavailable
                  ? "The published ledger is unavailable. Your verified balances remain visible above; retry to load reward history."
                  : "No published ledger for this address yet. Round weight, CHICK streak, carry-over and received history appear once indexed."}
              </p>
            )}
          </section>
        </>
      ) : (
        <div className="wallet-standing">
          <Art id="chick" />
          <div>
            <span className="eyebrow">LONG-TERM HOLDER?</span>
            <h2>THE CHICK REMEMBERS.</h2>
            <p>
              Hold CHICK for complete rounds to build a streak. The multiplier
              grows by 0.5× per round, up to 3×.
            </p>
            <Link className="text-link" href="/whitepaper">
              READ THE PAYOUT RULES <LinkArrow />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function WalletLedgerView({ ledger }: { ledger: WalletLedger }) {
  const received = useArchive(
    ledger.received,
    ledger.receivedPages,
    "received",
    ledger.address,
  );
  const outdated = Date.now() / 1000 - ledger.updatedAt > 180;
  return (
    <>
      <p className="muted">
        Published{" "}
        {new Date(ledger.updatedAt * 1000)
          .toISOString()
          .replace("T", " ")
          .replace(".000Z", " UTC")}
        {ledger.round ? " · ROUND " + ledger.round : ""}
      </p>
      {outdated && (
        <p role="status" className="error">
          This ledger is delayed. Values below describe the last published
          record.
        </p>
      )}
      {ledger.eligibility === false ? (
        <p role="status" className="error">
          Excluded from holder rewards. Balances remain visible for reference;
          these holdings do not earn family or CHICK rewards.
        </p>
      ) : ledger.eligibility === null ? (
        <p role="status" className="muted">
          Holder reward eligibility has not been verified in this record. No
          reward weight is confirmed.
        </p>
      ) : (
        <p className="muted">
          Eligible for holder reward calculations at the published block. The
          round outcome and final manifest determine any payment.
        </p>
      )}
      <dl>
        <div>
          <dt>CHICK streak</dt>
          <dd>{ledger.chickStreak} completed rounds</dd>
        </div>
        <div>
          <dt>CHICK weighted units</dt>
          <dd className="wallet-amount">
            {ledger.eligibility === true
              ? formatEther(BigInt(ledger.chickWeightWei))
              : ledger.eligibility === false
                ? "NOT ELIGIBLE"
                : "NOT VERIFIED"}
          </dd>
        </div>
        {Object.entries(ledger.roundWeight).map(([family, weight]) => (
          <div key={family}>
            <dt>{human(family)} family weight</dt>
            <dd className="wallet-amount">
              {ledger.eligibility === true
                ? formatEther(BigInt(weight)) + " ETH"
                : ledger.eligibility === false
                  ? "NOT ELIGIBLE"
                  : "NOT VERIFIED"}
            </dd>
          </div>
        ))}
      </dl>
      <p>
        These weights describe holdings. Final eligibility and the published
        payout manifest determine payments.
      </p>
      <WalletRewards ledger={ledger} />
      <h3>CARRIED REWARDS</h3>
      <DataTable
        headings={["FROM ROUND", "CATEGORY", "ETH CARRIED"]}
        rows={ledger.carryover.map((row) => [
          String(row.round),
          row.category.toUpperCase(),
          <span key="amount" className="wallet-amount">
            {formatEther(BigInt(row.amountWei))}
          </span>,
        ])}
        empty="No carried rewards in this record."
      />
      <h3>CONFIRMED PAYMENTS</h3>
      {ledger.receivedHasMore && (
        <p className="muted">
          The latest 100 entries are shown below. Use the archive to browse
          earlier round ranges.
        </p>
      )}
      <ArchivePicker view={received} label="Payment archive" />
      <DataTable
        headings={["ROUND", "CATEGORY", "ETH RECEIVED", "TRANSACTION"]}
        rows={received.rows.map((row) => [
          String(row.round),
          row.category.toUpperCase(),
          <span key="amount" className="wallet-amount">
            {formatEther(BigInt(row.amountWei))}
          </span>,
          <a key="tx" href={explorer + "/tx/" + row.tx}>
            {short(row.tx)} <LinkArrow />
          </a>,
        ])}
        empty={
          received.busy
            ? "Loading payment archive…"
            : received.error
              ? "Payment records could not be loaded."
              : "No confirmed holder payments in this record."
        }
      />
    </>
  );
}
