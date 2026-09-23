import type { ReactNode } from "react";

export function Explain({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="explain">
      <summary>
        <span className="help-mark" aria-hidden="true">
          ?
        </span>
        {title}
        <span className="help-toggle" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="explain-body">{children}</div>
    </details>
  );
}
export function FamilyHelp() {
  return (
    <div className="help-grid">
      <Explain title="Does only the original chicken count?">
        <p>
          No. A family is its original token plus every officially launched
          variant. Buys and sells of any member add to that family's round
          volume. You do not have to hold the original token.
        </p>
        <p>
          Example: 2 ETH traded on Catalana + 3 ETH on a launched Catalana
          variant = 5 ETH for the Catalana family. A hatch joins the trading
          total only after its official token launches.
        </p>
      </Explain>
      <Explain title="Does trading volume decide my reward?">
        <p>
          Trading volume decides which family wins. Your personal reward in a
          hatch round depends on your average holdings over the whole round,
          valued in ETH at the round's closing prices. Eligible holdings across
          every token in the winning family are added together.
        </p>
        <p>
          Trading is not a deposit into a shared pool, and trading more does not
          directly earn you a larger payout. Rewards depend on the round outcome
          and eligibility rules.
        </p>
      </Explain>
      <Explain title="When does a round end?">
        <p>
          The combined volume of all three families moves the round toward its
          threshold. The qualifying swap ends the round immediately, with no
          minimum duration; the family with the highest volume wins. If no
          qualifying finish occurs within 72 hours from round 2 onward, the
          round times out and the pot cooks EGG. Round 1 starts with the first
          verified family trade and has no timeout: its threshold is 100 ETH.
        </p>
        <p>
          EGG and CHICK trades help fund the pot, but do not count in the family
          race. The threshold rises by 10% for each new variant launched
          on-chain, taking effect at the next round's start. It stays fixed
          throughout a round; a timeout or a win without a variant launch adds
          no increase.
        </p>
      </Explain>
      <Explain title="Do trades count while an egg incubates?">
        <p>
          Yes. The next round starts at the very next block. All family trading
          volume counts immediately, even while earlier eggs are incubating.
          Each egg has its own 10-hour timer; there is no break between rounds.
        </p>
        <p>
          If a round ends at 07:00 and the next ends at 09:00, their eggs hatch
          from 17:00 and 19:00 respectively. The new tokens become tradable only
          after their official launches are confirmed on-chain.
        </p>
      </Explain>
    </div>
  );
}
