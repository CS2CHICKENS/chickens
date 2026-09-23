import { z } from "zod";
const uint = z.string().regex(/^\d+$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const incubatorSchema = z.object({
  status: z.enum(["idle", "incubating", "hatched", "launched"]),
  family: z.string(),
  hatchAt: z.number(),
  remaining: z.array(z.string()),
  result: z
    .object({
      variant: z.string(),
      block: z.number(),
      hash: z.string(),
      tokenAddress: z.string(),
    })
    .nullable(),
});
export const publicStateSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["live", "monitoring", "demo", "unconfigured"]),
  updatedAt: z.number(),
  headBlock: z.number(),
  stale: z.boolean(),
  round: z.object({
    id: z.number(),
    startBlock: z.number(),
    threshold: uint,
    growthSteps: z.number().int().nonnegative().default(0),
    progress: z.number(),
    volumeByFamily: z.record(z.string(), uint),
    volumeByToken: z.record(z.string(), uint),
    endsBy: z.number(),
    potWei: uint,
  }),
  tokens: z.array(
    z.object({
      id: z.string(),
      address,
      family: z.string().optional(),
      priceEth: z.number(),
      priceUsd: z.number().nullable(),
      marketCapUsd: z.number().nullable(),
      volumeRoundEth: z.number(),
      holders: z.number(),
      graduationProgress: z.number(),
    }),
  ),
  incubator: incubatorSchema,
  incubators: z
    .array(incubatorSchema.extend({ round: z.number() }))
    .default([]),
  feed: z.object({
    balanceWei: uint,
    owedWei: uint,
    accruingWei: uint,
    devWithdrawnWei: uint,
    generatedWei: uint.nullable().default(null),
    generatedRoundWei: uint.nullable().default(null),
    collectedWei: uint.nullable().default(null),
    claimableWei: uint.nullable().default(null),
    feeAccountingStartBlock: z.number().nullable().default(null),
    developerSource: z
      .enum(["split", "collection", "unavailable"])
      .default("unavailable"),
    accountingReady: z.boolean().default(true),
    collection: z
      .object({
        status: z.enum(["verified", "ambiguous", "backfilling"]),
        fromBlock: z.number(),
        throughBlock: z.number().nullable(),
        lowerBoundWei: uint.nullable(),
        upperBoundWei: uint.nullable(),
        escrowClaimedWei: uint.nullable(),
        otherCreditsWei: uint.nullable(),
      })
      .optional(),
  }),
  kitchen: z.object({
    eggBurnedTotal: uint,
    supplyLeftWei: uint.nullable().default(null),
    lastCooks: z.array(
      z.object({
        round: z.number(),
        token: z.string(),
        ethIn: uint,
        tokensBurned: uint,
        tx: z.string(),
      }),
    ),
  }),
  ticker: z.array(
    z.object({
      ts: z.number(),
      wallet: z.string(),
      token: z.string(),
      side: z.enum(["buy", "sell"]),
      ethAmount: z.number(),
      tx: z.string(),
    }),
  ),
  history: z.object({
    wins: z.record(z.string(), z.number().int().nonnegative()).optional(),
    pages: z
      .object({
        pageSize: z.number().int().positive(),
        totalPages: z.number().int().nonnegative(),
        basePath: z.string(),
      })
      .optional(),
    rounds: z.array(
      z.object({
        id: z.number(),
        winner: z.string().nullable(),
        potWei: uint,
        endReason: z.string(),
        endBlock: z.number(),
        payoutHash: z.string().optional(),
        accountingVerified: z.boolean().default(false),
        settlementStatus: z
          .enum(["pending", "published", "partial", "distributed"])
          .default("pending"),
        payoutTransactions: z.array(z.string()).default([]),
        payoutTransactionsHasMore: z.boolean().optional(),
      }),
    ),
    hatches: z.array(
      z.object({
        round: z.number(),
        family: z.string(),
        variant: z.string(),
        block: z.number(),
        hash: z.string(),
        tokenAddress: z.string().nullable(),
      }),
    ),
  }),
});
export type PublicState = z.infer<typeof publicStateSchema>;
export const emptyState: PublicState = {
  version: 1,
  mode: "unconfigured",
  updatedAt: 0,
  headBlock: 0,
  stale: true,
  round: {
    id: 1,
    startBlock: 0,
    threshold: "0",
    growthSteps: 0,
    progress: 0,
    volumeByFamily: {},
    volumeByToken: {},
    endsBy: 0,
    potWei: "0",
  },
  tokens: [],
  incubator: {
    status: "idle",
    family: "",
    hatchAt: 0,
    remaining: [],
    result: null,
  },
  incubators: [],
  feed: {
    balanceWei: "0",
    owedWei: "0",
    accruingWei: "0",
    devWithdrawnWei: "0",
    generatedWei: null,
    generatedRoundWei: null,
    collectedWei: null,
    claimableWei: null,
    feeAccountingStartBlock: null,
    developerSource: "unavailable",
    accountingReady: true,
  },
  kitchen: { eggBurnedTotal: "0", supplyLeftWei: null, lastCooks: [] },
  ticker: [],
  history: { rounds: [], hatches: [] },
};

const walletAmountSchema = z.object({
  round: z.number(),
  category: z.enum(["family", "chick"]),
  amountWei: uint,
});
export const walletLedgerSchema = z.object({
  address,
  updatedAt: z.number(),
  headBlock: z.number().optional(),
  eligibility: z.boolean().nullable().default(null),
  round: z.number().optional(),
  holdings: z.array(z.object({ token: z.string(), balanceWei: uint })),
  chickStreak: z.number(),
  chickWeightWei: uint,
  roundWeight: z.record(z.string(), uint),
  carryover: z.array(walletAmountSchema),
  pendingRewards: z
    .object({
      ready: z.boolean(),
      totalWei: uint.nullable(),
      count: z.number().int().nonnegative().nullable(),
      latest: z.array(walletAmountSchema).max(100),
      hasMore: z.boolean(),
    })
    .optional(),
  received: z.array(walletAmountSchema.extend({ tx: z.string() })),
  receivedHasMore: z.boolean().default(false),
  receivedPages: z
    .object({
      pageSize: z.number().int().positive(),
      totalPages: z.number().int().nonnegative(),
      basePath: z.string(),
      ready: z.boolean(),
    })
    .optional(),
});
export type WalletLedger = z.infer<typeof walletLedgerSchema>;
