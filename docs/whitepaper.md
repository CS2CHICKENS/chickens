# CS2 Chickens — Whitepaper

> **Not affiliated with, endorsed by, or connected to Valve Corporation.** Counter-Strike and CS2 are trademarks of Valve. CS2 Chickens is an independent fan project.

## 1. What this is

CS2 Chickens is a family of meme tokens on Robinhood Chain, launched through pons. Chicken breeds compete in trading-volume rounds. The winning breed hatches a new chicken token, its holders share a prize, and part of every pot is used to buy and burn EGG.

Everything described here is computed from public on-chain data. Anyone can verify every round, every hatch and every payout.

## 2. Official tokens

Only addresses listed here and on cs2chickens.fun are official. Names and images can be copied; addresses cannot.

| Token    | Role                                                        | Address                                      |
| -------- | ----------------------------------------------------------- | -------------------------------------------- |
| EGG      | The egg every chicken comes from. Gets cooked (buy & burn). | `0xC096A06220CE42eE949c059Ab898bcEcae936ad4` |
| CHICK    | The chick that grows. Rewards long-term holders.            | `0x49ABc5C8541ef0d2188C3b4fe51e969fC8d4D3dc` |
| CATALANA | Breed — Catalana family                                     | `0x980b23Ef548A20f7c5FDeaD85bdA2566512A442f` |
| POLISH   | Breed — Polish family                                       | `0x1F563Fc8C7E926cA8552766468d75302398380EA` |
| SILKIE   | Breed — Silkie family                                       | `0x68F6f732a564A9523A69830d60b11D8c52C53Bb4` |

Every hatched variant is added to this list automatically when it launches.

Creator wallet: `0xF4f7…D4E9` (full address on the site). Every official token is deployed by this wallet.

## 3. Families

A **family** is a breed's default token plus every variant hatched from it.

| Family   | Variants still in the egg (Season 1) |
| -------- | ------------------------------------ |
| Catalana | 15                                   |
| Polish   | 13                                   |
| Silkie   | 13                                   |

EGG and CHICK are not families. They do not compete in rounds, but they earn from every round (see §6).

## 4. Rounds

- A round ends when the **combined trading volume of all family tokens** reaches the round threshold. EGG and CHICK volume does not count toward the threshold.
- **No minimum duration:** a qualifying trade can finish a round immediately, including in its opening block.
- **Opening:** round 1 starts at the block of the first confirmed, verified family trade with nonzero volume. EGG, CHICK, zero-volume events and fee credits cannot start it. Verified official-token creator fees recognized before that block are reserved for round 1 and included once in its pot. Earlier volume does not count toward the family quota or holding period.
- **Timeout:** round 1 has no time limit. From round 2 onward, a round without a qualifying finish within 72 hours ends with no winner (see §8).
- The **winning family** is the family with the most trading volume during the round (default + all its variants combined).
- The round ends at the exact block of the swap that crosses the threshold. The next round starts at the next block.
- A fee-credit event cannot end a round. Incubation never delays the next round or excludes its trading volume.
- All trades in the end block count toward that round. From round 2 onward, timeout takes precedence at the 72-hour boundary. Equal family volumes are resolved by ascending family identifier.
- A threshold is fixed when its round starts. Each verified launch of a newly hatched variant increases the threshold by 10% for rounds whose opening block is later than that launch block. An egg in incubation, a hatch without a launched token, a timeout or a fire-round win adds no increase. Multiple qualifying launches before the next opening compound the increase.
- Volume is measured in native ETH from the verified Pons v2 curve or Uniswap v4 pool events. Curve sells include their fee and tax in gross volume. Pons' internal fee-conversion and buyback swaps are excluded from competition volume.

Current parameters are published on the site before each round starts.

| Parameter             | Value                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Round 1 threshold     | 100 ETH of combined family volume                                                        |
| Threshold progression | 100 ETH × 1.1^(qualifying variant launches before the round starts), rounded down to wei |
| Minimum duration      | None                                                                                     |
| Timeout               | None for round 1; 72 hours from round 2 onward                                           |
| Incubation            | 10 hours                                                                                 |

## 5. Fees and the Feed

Pons v2 records a base trading fee and a separate creator tax. The creator receives the creator portion of that base fee plus the creator tax. The actual amounts come from contract events and integer accounting, **not a fixed percentage of volume**. Launch taxes, fee rounding and token-denominated fees can change the effective percentage.

The public collection wallet receives 100% of the project's claimed creator fees:
`0x9C05Be9E7017f369169E57E2e0680ca3Ec8a871F`.

- **50% to the developer**, at `0x3b6c23AE79689303fE29167c4f3b89BAA4D0A5C1`.
- **50% to the community Feed**, for holder distributions and buybacks/burns.

The collection and Feed wallet are the same address above. The launch wallet is `0xF4f77f8C93b545a0C9364E9ef5F5E6fcEFB3D4E9`; it is not the developer payment destination. The local settlement application claims the exact verified gross fees for a completed round, sends that allocation through Split, pays the developer half and returns the community half to Feed. Previously reserved community funds are not split again. Split records each round once; Multisend records each round and batch once. These contracts still rely on the operator submitting the independently verified allocation.

The split is a distribution of the project's creator fees, not of all fees paid to the Pons protocol. For the currently configured curve policies, the ordinary creator entitlement is approximately 1.7% of gross volume before rounding; this is not used as a calculation shortcut.

The **pot** of a round is computed, not guessed:

```
roundFees = verified ETH creator fees recognized during the round
allocatedFees = roundFees + openingReserve (round 1 only)
pot = floor(allocatedFees / 2)
```

`openingReserve` contains verified ETH creator fees from official tokens before the first family trade, starting at the published fee-accounting block. It is included only in round 1. FEED displays those fees and each token's indexed trading volume even while the family competition is waiting to start. The reserve does not change the 100 ETH family quota or give earlier holdings additional round time.

Native-ETH fees are recognized when they accrue, including EGG and CHICK trades. The calculation preserves Pons' aggregate protocol-fee rounding across trades and resets at each sweep. After graduation, some fees accrue in tokens. They enter the ETH pot only when an on-chain conversion and sweep prove the actual ETH proceeds; they are assigned to the round containing that realization, not retroactively estimated at a market price. Unknown or changed fee policies stop settlement until reconciled.

The pot is fixed at the round's end block. **Generated, claimable, collected and distributed are different stages.** Accrued fees can still require a Pons sweep, escrow claim and transfer to the Feed. The site never treats the collection wallet's balance as fee revenue. Published accounting coverage shows where verification begins; an unavailable amount is not zero.

The collected total follows confirmed ETH claims and direct fee payments to the collection wallet, counting only creator fees attributed to registered project tokens. Anyone can add unrelated credits to the Pons escrow. If a partial claim mixes project fees and other credits, the chain does not identify which funds were withdrawn: the site reports lower and upper bounds until the project amount can be determined exactly. A complete withdrawal resolves the remaining mixed balance. Claims made outside the local application are included when their confirmed events are indexed. Historical catch-up remains visible; the wallet balance is never used to fill a gap.

Before round activation, fees accrued to the original creator destination are excluded from the collection wallet's generated total. The initial transfer of fee rights to the configured collection wallet is accepted only with no pending curve fees or creator tax. Outstanding balances, other recipient changes, and changes during active rounds require reconciliation before accounting continues.

The operator initiates settlement locally using wallet confirmations. Until a transaction is confirmed, the site shows an obligation or pending operation, not a completed payment. Any per-round/split rounding difference remains a separately reconcilable Feed reserve. The developer counter covers only proven project-fee payments to the developer destination. It does not follow that address's later spending.

Settlement amounts come from the verified round manifest, never from the Feed wallet's available balance. Extra deposits or funds for later rounds cannot enlarge the current allocation. The local workflow allocates the developer half through Split before sending holder payments or cooking, then finishes that round before starting another settlement. Unrecorded manual claims or outgoing transfers stop settlement for reconciliation; the application does not infer which round they paid. Previous small rewards can be paid with a later round only through the manifest's explicit carry-over accounting.

## 6. Pot split

### Hatch round (the winning family still has variants in the egg)

| Share   | Goes to                       | How                                                      |
| ------- | ----------------------------- | -------------------------------------------------------- |
| **60%** | Holders of the winning family | ETH, pro rata to time-weighted holdings (§7)             |
| **30%** | EGG                           | Cooked: bought on the market and burned                  |
| **10%** | CHICK holders                 | ETH, pro rata to time-weighted holdings × seniority (§7) |

### Fire round (the winning family has no variants left)

Nothing is sent. Everything is bought and burned.

| Share   | Burned                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------- |
| **40%** | Tokens of the winning family, split by each token's volume in the round                         |
| **30%** | EGG (cooked)                                                                                    |
| **30%** | All official tokens (EGG and CHICK included), split by each token's share of total round volume |

A token with less than 1% of the round's volume is not bought; its share is cooked into EGG instead.

## 7. Who gets paid, and how much

**Time-weighted holdings.** A wallet's weight is its average balance over the whole round, not a snapshot. Holding for 24 hours weighs 24× more than holding for 1 hour. Buying just before the end earns almost nothing.

**Family value.** Family tokens have different prices, so each wallet's holdings across the family are valued in ETH at the round's end price, then summed.

**Instant rounds.** If a round opens and closes at the same timestamp, there is no elapsed time to average. Its holding weights use balances immediately before its opening block. Purchases within that instant round add competition volume but cannot create holding weight for that round.

**CHICK seniority.** A wallet's streak increases by 1 for each consecutive round in which it held CHICK from start to end. If its balance reaches zero during a round, the streak resets. Multiplier: `1 + 0.5 × streak`, capped at **3×**.

**Excluded addresses:** liquidity pools and curves, lockers, the burn address, the creator, developer, collection and Feed wallets, protocol contracts and other smart contracts.

**Minimum payout and carry-over.** Sending ETH costs gas. The recipient cutoff uses an estimated transfer cost capped at **3% of the pot**. The reproducible reference is 40,000 gas per recipient at twice the end-block base fee plus 1,000,000 wei per gas priority fee. This is a cutoff estimate; the operator must verify actual transaction costs before sending. Gas is funded separately by the operator, so the pot's 60/30/10 or burn allocations remain intact. There is no second gas deduction from the cooking budget.

Amounts below the cutoff carry over until eligible. Carry-overs still below the cutoff after **3 rounds** are cooked into EGG. The cutoff and carry-over list are published with each distribution manifest. A payment is counted only after its confirmed receipt is verified; a failed report must be retried without sending the payment again.

## 8. Cooking the EGG

Cooking = buying EGG on the market and sending it to the conventional dead address `0x000000000000000000000000000000000000dEaD`. Tokens held there are treated as out of circulation. This transfer does not reduce the token contract's `totalSupply`; the site's supply-left figure subtracts the dead-address balance from the on-chain total supply. A native `burn()` call is a different operation and is not the current cook method.

- Purchases are split into several smaller buys spread over about an hour after the round ends, to limit front-running.
- Every cook is shown on the site with its transaction.

**Timeout rounds are fully cooked.** If a round ends by timeout, there is no winner and no hatch: **100% of the pot cooks EGG.** The egg that didn't hatch goes to the pan.

EGG therefore receives 30% of every hatch round, 30%+ of every fire round, and 100% of every timeout round.

## 9. Hatching

When a round is won by a family with variants left, that family's egg enters the incubator for **10 hours**.

The hatched chicken is chosen by a rule published in advance, with no discretionary selection by the application:

1. `T` = end-of-round block timestamp + 10 hours.
2. The **hatch block** is the first Robinhood Chain block with a timestamp ≥ `T`.
3. The family's remaining variants are sorted by identifier in **plain ASCII order** (the default JavaScript `sort()`), e.g. `silkie-black`, `silkie-blue-with-red-beard`, `silkie-brown`, … The full identifier list is published on the site before Season 1 starts.
4. `index = uint256(hatch block hash) mod number of remaining variants`.
5. The variant at that index hatches.

The open-source `hatch` script recomputes any result directly from the chain, without the site.

Rounds continue while eggs incubate. A hatch round reserves one remaining slot for its family at round end. Pending reservations count as used slots when classifying later wins; two pending eggs cannot both reserve the final slot. At each hatch, the result uses the identifiers remaining after earlier hatches in chronological round order. The published block hash and exact sorted list prove the result. A block hash is deterministic chain data, not a guarantee against influence by the chain's block producer.

After the hatch, the developer launches the new token on pons from the creator wallet. The site detects the launch on-chain and displays the official address automatically. **Never trust an address posted anywhere else first.**

The hatch only decides _which chicken launches_. No money is ever distributed by chance.

## 10. Seasons

- A **season** covers the chickens available at the time. Season 1 = the breeds and variants listed in §3.
- When every variant of a family has hatched, that family keeps competing; if it wins, the round is a fire round (§6).
- When every variant of every family has hatched, the game runs in fire rounds only (the **off-season**).
- **If** new chickens are ever added to CS2, a new season may open under the same rules: new variants become hatchable, and new breeds join as new families. This is not a promise; the project does not control game updates.

## 11. Transparency

The site publishes, for every round: volume per token, the pot, the payout list with its hash, every transaction (payouts, cooks, burns), the hatch block and its hash, and the developer's withdrawn share. All of it can be checked on the explorer.

Historical records are available in pages so growing activity does not require every visitor to download the entire ledger. A distribution's complete manifest remains verifiable against its published commitment. Indexing, settlement calculation and publication resume from confirmed checkpoints; each dataset exposes its own coverage or freshness. The static site reads published files, while the local operator submits confirmed transaction receipts through a separate authenticated endpoint.

## 12. Risks

- These are meme tokens. They have no intrinsic value, no utility beyond this game, and can go to zero.
- Rewards depend on trading volume. With no volume, there are no rewards.
- Nothing here is a promise of price, returns, or future seasons.
- Smart contracts, RPCs, indexers and the site can fail. Payouts may be delayed.
- Rules may be adjusted between rounds for technical reasons; changes are announced before the round they apply to.
- Check the laws of your country before participating. Nothing here is financial advice.
