import { LinkArrow } from "./link-arrow";
import Link from "next/link";
import { Explain } from "./help";

export function FeeFlow() {
  return (
    <section className="fee-flow" aria-label="How creator fees are distributed">
      <div className="section-label spacious">
        <h2>WHERE THE FEES GO</h2>
        <span>PUBLISHED GAME RULES</span>
      </div>
      <p>
        Every official token helps fund the game, including EGG and CHICK. The
        creator fee is split before the community pot is distributed.
      </p>
      <div className="fee-example">
        <span className="eyebrow">
          EXAMPLE · 1 ETH OF COLLECTED CREATOR FEES
        </span>
        <strong>1 ETH to allocate</strong>
        <span>
          Illustrative allocation of collected fees, not a live balance or a
          trading fee quote
        </span>
      </div>
      <div className="fee-branches">
        <article>
          <span className="eyebrow">50% OF CREATOR FEES</span>
          <h3>0.5 ETH → DEVELOPER</h3>
          <p>
            The developer's disclosed share: half of collected creator fees. It
            is allocated from the fee collection wallet to the developer,
            separately from the community's share.
          </p>
        </article>
        <article>
          <span className="eyebrow">50% OF CREATOR FEES</span>
          <h3>0.5 ETH → THE FEED</h3>
          <p>
            The other half stays allocated to the community in the same public
            Feed wallet that collects the fees. This share funds eligible holder
            rewards and token buybacks and burns according to the round outcome.
          </p>
        </article>
      </div>
      <div className="help-grid">
        <Explain title="What does “Developer fees paid” mean?">
          <p>
            The developer is allocated 50% of creator fees, separate from the
            community allocation. The displayed counter covers recorded
            split-contract releases only. Until that contract is deployed and
            indexed, it shows “Not indexed”, rather than claiming that no
            developer transfers have occurred.
          </p>
          <p>
            The percentage stays the same as volume grows. In the example above,
            the developer receives 0.5 ETH and the Feed receives 0.5 ETH. You
            can inspect transfers from the public collection wallet on the
            explorer. The planned split contract will provide separate, indexed
            release receipts.
          </p>
        </Explain>
        <Explain title="Where does developer payment tracking stop?">
          <p>
            The site reports project fee payments to the developer's published
            receiving address. This is a cumulative payment total, not the
            balance of that wallet. Personal spending and onward transfers are
            outside this fee report.
          </p>
          <p>
            Transactions remain public on the blockchain and can be inspected
            independently on an explorer.
          </p>
        </Explain>
        <Explain title="Why is the current pot different from the Feed balance?">
          <p>
            The community receives 50% of verified ETH creator fees recognized
            during the round. Round 1 also includes verified creator fees
            reserved before its first family trade. The Feed balance is the ETH
            currently held by the collection and community wallet. Its balance
            may include the developer's unpaid share and reserved community
            funds. They can differ while fees are awaiting collection, rewards
            are unpaid, or cooks and payouts are being executed.
          </p>
          <p>
            Generated fees, claimable fees and collected fees are separate
            amounts. A collection can cover several rounds; it does not decide
            which round earned those fees. Unverified amounts stay unavailable.
          </p>
          <p>
            A calculated reward is not a completed payment. Payouts require
            available funds and published transaction receipts.
          </p>
        </Explain>
        <Explain title="How does the community receive its share?">
          <p>
            In a hatch round, the published split is 60% for eligible holders of
            the winning family, 10% for eligible CHICK holders and 30% for EGG
            buybacks and burns. Your holder share depends on time-weighted
            holdings, not the number of trades you make.
          </p>
          <p>
            A timeout uses the pot to buy and burn EGG. When a complete family
            wins a fire round, the pot buys and burns tokens instead of paying
            holders. Sending costs and small carried amounts follow the payout
            rules.
          </p>
          <Link className="text-link" href="/whitepaper">
            READ ALL DISTRIBUTION RULES <LinkArrow />
          </Link>
        </Explain>
      </div>
    </section>
  );
}
