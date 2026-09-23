# CS2 Chickens

Three token families compete in public trading-volume rounds on Robinhood Chain. Round winners hatch new variants; the Feed funds deterministic holder payouts and public token burns.

Not affiliated with Valve. Meme tokens can lose all value. See the [whitepaper](docs/whitepaper.md) for rules and risks.

## Run locally

Use Node.js 24 and npm on Windows, macOS or Linux.

```powershell
npm ci
npm run dev
```

The preview runs at http://127.0.0.1:3000. Artwork is served from an external asset origin in production; the asset pipeline expects the separately supplied source pack. Monitoring can show verified prices and trades before round activation. Missing data is displayed as unavailable.

```powershell
npm run assets
npm test
npm run test:contracts
npm run typecheck
npm run build
npm run preview
```

The static export is written to `apps/web/.next-build`. The frontend reads cached JSON from the public data origin, never from the engine. Set `NEXT_PUBLIC_ASSET_BASE` and `NEXT_PUBLIC_DATA_BASE` when building for another origin.

## Verification

All monetary arithmetic uses integers in `packages/core`. Pons v2 curve prices use tradeable reserves; graduated pools use Uniswap v4 slot data. The pot is half of verified creator fees recognized in ETH during the round, with protocol rounding preserved. Token-denominated fees enter the pot when their conversion is proven on chain. EGG and CHICK contribute fees but their volume does not count toward the family threshold. See the [fee recognition rules](docs/whitepaper.md#5-fees-and-the-feed).

The hatch uses the first block at or after the incubation deadline:

```text
ids = remainingVariantIds.sort()
index = uint256(blockHash) % ids.length
variant = ids[index]
```

```powershell
npm run hatch -- --round 1
npm run distribute -- --round 1 --dry-run
npm run simulate
npm run verify:chain
```

The hatch verifier reconstructs history from the chain and public config. Distribution recomputes weights and carry-over independently of the database, checks the canonical manifest hash, and the Rabby application refuses gas spending that would consume reserved community funds. Historical reads and event logs prefer the public dRPC endpoint. Logs use ranges of at most 100 blocks; contract reads use batches of at most three. Providers are tried once per request, and the work queue handles delayed retries without committing incomplete ranges. No account or API key is required for these endpoints; public access has rate limits and is not an anonymity guarantee. An optional private `BACKUP_RPC_URL` takes priority. Run `npm run verify:chain -- --archive` to verify historical state access; a recent-block fallback cannot replace archive reads.

Payout hashes use Keccak-256 of UTF-8 JSON containing the round number and positive payouts sorted by lowercase wallet then category. Amounts are decimal wei strings.

Settlement commands verify or prepare plans by default. Use `npm run operator` for the local Rabby application at http://127.0.0.1:8788. It deploys and verifies the settlement contracts, independently recomputes published round manifests, and prepares sweep, claim, split, holder batches, purchases and burns. Every transaction requires confirmation in Rabby; the server never receives a signing key. The older command-line `--execute` flag remains disabled. The developer receiving address does not sign holder payouts. Public developer fee reporting counts project payments and does not follow subsequent personal transfers.

Keep `private/operator-runs` when restarting: it links every proposed operation to its confirmed transaction and prevents accidental resubmission. Unknown submissions require receipt reconciliation; a confirmed revert can be reset and simulated again. Reporting requires `ADMIN_URL` (the HTTPS Worker origin) and `ADMIN_SECRET` in the local process environment. A reporting failure resumes from the saved payment instead of paying twice. Pons can reserve some fee conversions for its own sweep operator; the local application cannot bypass that role.

## Components

- `apps/web`: responsive static Next.js site.
- `apps/worker`: bounded indexer, D1 ledger, cached R2 publication and authenticated administration.
- `packages/core`: shared round, hatch, balance and settlement rules.
- `contracts`: immutable Split and atomic Multisend contracts.
- `scripts`: local verification and operator tooling.

The indexer waits for configured confirmations, reads sparse event headers and persists its progress. It pauses if a persisted block hash changes. Errors are retained in D1; no external notifications are sent. The site flags stale data when updates stop. Failed publication retries the same receipts instead of sending funds again.

Public protocol references: [Pons contract source](https://github.com/ponsdotdev/pons-labs/tree/main/contractsV2/src/v2), [Uniswap v4 state layout](https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol).

## License

Code is licensed under MIT. Supplied artwork is distributed separately and is not included in the code license.
