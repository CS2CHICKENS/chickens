import {
  createPublicClient,
  fallback,
  http,
  parseAbi,
  encodeAbiParameters,
  keccak256,
  zeroAddress,
  formatLog,
  parseEventLogs,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  config,
  matchesVariant,
  priceWei,
  abs,
  WAD,
  BPS,
  type Token,
  type Swap,
} from "./index";
import { rpcFailure, type RpcFailureObserver } from "./rpc-failure";

export const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "struct FeePolicy { address protocolFeeRecipient; uint16 protocolFeeShareBps; uint16 buybackBurnBps; uint16 hookFeeBps; uint16 maxInternalPriceImpactBps; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function getLaunchFeePolicy(address token) view returns (FeePolicy)",
  "function poolManager() view returns (address)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);
export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export const curveAbi = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function trackedQuote() view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)",
  "event FeesRescued(address indexed protocolRecipient, address indexed creatorRecipient, uint256 protocolAmount, uint256 creatorAmount)",
  "event BuybackEnabledUpdated(bool enabled)",
  "event CreatorFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient)",
]);
export const poolAbi = parseAbi([
  "function extsload(bytes32 slot) view returns (bytes32)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
export const hookAbi = parseAbi([
  "function pendingFees(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)",
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
  "event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked)",
  "event PoolFeesRescued(bytes32 indexed poolId, address indexed quoteToken, uint256 protocolAmount, uint256 creatorAmount)",
  "event BuybackEnabledUpdated(bytes32 indexed poolId, bool enabled)",
  "event CreatorFeeRecipientUpdated(bytes32 indexed poolId, address indexed previousRecipient, address indexed newRecipient)",
]);
export const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "event Credited(address indexed recipient, address indexed depositor, uint256 amount)",
  "event Claimed(address indexed recipient, uint256 amount)",
]);
export const chain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: config.rpc } },
};
export function client(backup?: string, onFailure?: RpcFailureObserver) {
  const urls = [...new Set([...(backup ? [backup] : []), ...config.rpc])];
  const providerKeys = new Map(
    urls.map((_, index) => ["rpc-" + (index + 1), index + 1]),
  );
  const transports = (logs = false) =>
    fallback(
      urls.map((url, index) =>
        http(url, {
          key: "rpc-" + (index + 1),
          timeout: 20000,
          retryCount: 0,
          batch: logs ? false : { batchSize: 3, wait: 20 },
        }),
      ),
      {
        rank: false,
        retryCount: 0,
        // A smaller range should retry the same provider, not mask its error.
        ...(logs ? { shouldThrow: logRangeError } : {}),
      },
    );
  return createPublicClient({
    chain,
    transport: (options) => {
      const archive = transports()(options);
      const logs = transports(true)(options);
      if (onFailure)
        for (const transport of [archive, logs])
          transport.value?.onResponse(
            ({ status, error, method, transport: provider }) => {
              if (status !== "error") return;
              try {
                void Promise.resolve(
                  onFailure(
                    rpcFailure(
                      error,
                      method,
                      providerKeys.get(provider.config.key),
                    ),
                  ),
                ).catch(() => {});
              } catch {
                // An observer cannot change request or fallback behavior.
              }
            },
          );
      return {
        ...archive,
        request: ((args, requestOptions) =>
          (args.method === "eth_getLogs" ? logs : archive).request(
            args,
            requestOptions,
          )) as typeof archive.request,
      };
    },
  });
}
type Rpc = ReturnType<typeof client>;
const managerCache = new WeakMap<Rpc, Promise<Address>>();
export function poolManager(rpc: Rpc) {
  let result = managerCache.get(rpc);
  if (!result) {
    result = rpc.readContract({
      address: config.factory as Address,
      abi: factoryAbi,
      functionName: "poolManager",
    });
    managerCache.set(rpc, result);
    result.catch(() => managerCache.delete(rpc));
  }
  return result;
}
export function v4PoolId(
  token: Address,
  pair: Address,
  fee: number,
  tickSpacing: number,
) {
  const isToken0 = BigInt(token) < BigInt(pair);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [
        isToken0 ? token : pair,
        isToken0 ? pair : token,
        fee,
        tickSpacing,
        config.protocol.hook as Address,
      ],
    ),
  );
}
export async function launchInfo(
  rpc: Rpc,
  address: Address,
  blockNumber?: bigint,
) {
  const launch = await rpc.readContract({
    address: config.factory as Address,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [address],
    blockNumber,
  });
  if (
    !launch.exists ||
    launch.pairToken !== zeroAddress ||
    launch.deployer.toLowerCase() !== config.wallets.creator?.toLowerCase()
  )
    throw Error("Unsupported token launch");
  const historicalCreator =
    blockNumber !== undefined &&
    blockNumber < BigInt(config.round.startBlock ?? Number.MAX_SAFE_INTEGER) &&
    launch.creatorFeeRecipient.toLowerCase() ===
      config.wallets.creator?.toLowerCase();
  if (
    launch.creatorFeeRecipient.toLowerCase() !==
      config.fees.collectionWallet.toLowerCase() &&
    !historicalCreator
  )
    throw Error("Creator fee recipient changed; reconcile before continuing");
  return launch;
}
export async function tokenSnapshot(
  rpc: Rpc,
  address: Address,
  blockNumber?: bigint,
) {
  const launch = await launchInfo(rpc, address, blockNumber);
  const [supply, policy] = await Promise.all([
    rpc.readContract({
      address,
      abi: tokenAbi,
      functionName: "totalSupply",
      blockNumber,
    }),
    rpc.readContract({
      address: config.factory as Address,
      abi: factoryAbi,
      functionName: "getLaunchFeePolicy",
      args: [address],
      blockNumber,
    }),
  ]);
  const id = v4PoolId(
    address,
    launch.pairToken,
    launch.poolFee,
    launch.tickSpacing,
  );
  let value: bigint, progress: number;
  const manager = await poolManager(rpc);
  if (launch.phase < 2) {
    const [reserves, tracked, fees, tax] = await Promise.all([
      rpc.readContract({
        address: launch.curve,
        abi: curveAbi,
        functionName: "getReserves",
        blockNumber,
      }),
      rpc.readContract({
        address: launch.curve,
        abi: curveAbi,
        functionName: "trackedQuote",
        blockNumber,
      }),
      rpc.readContract({
        address: launch.curve,
        abi: curveAbi,
        functionName: "quoteFeeBalance",
        blockNumber,
      }),
      rpc.readContract({
        address: launch.curve,
        abi: curveAbi,
        functionName: "creatorTaxBalance",
        blockNumber,
      }),
    ]);
    if (reserves[1] <= 0n)
      throw Error("Curve price unavailable during graduation");
    value = (reserves[0] * WAD) / reserves[1];
    progress =
      launch.phase === 1
        ? 1
        : Math.min(
            1,
            Number(
              ((tracked - fees - tax) * 10000n) / launch.graduationThreshold,
            ) / 10000,
          );
  } else {
    const slot = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n]),
    );
    const packed = await rpc.readContract({
      address: manager,
      abi: poolAbi,
      functionName: "extsload",
      args: [slot],
      blockNumber,
    });
    value = priceWei(BigInt(packed) & ((1n << 160n) - 1n), false);
    progress = 1;
  }
  const launchBlocks = (
    config as typeof config & { tokenLaunchBlocks?: Record<string, number> }
  ).tokenLaunchBlocks;
  const base = config.tokens.find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  );
  return {
    pool: launch.phase === 2 ? manager : launch.curve,
    curve: launch.curve,
    phase: launch.phase,
    poolId: id,
    isToken0: false,
    priceWei: value,
    supply,
    creator: launch.deployer,
    graduationProgress: progress,
    launchBlock: base ? launchBlocks?.[base.id] : undefined,
    feeVerified:
      !launch.buybackEnabled &&
      launch.creatorFeeRecipient.toLowerCase() ===
        config.fees.collectionWallet.toLowerCase(),
    creatorFeeRecipient: launch.creatorFeeRecipient,
    creatorTaxBps: launch.creatorTaxBps,
    protocolFeeShareBps: policy.protocolFeeShareBps,
  };
}
export async function readTokenLaunches(rpc: Rpc, from: bigint, to: bigint) {
  const logs = await bounded(from, to, (fromBlock, toBlock) =>
    rpc.getContractEvents({
      address: config.factory as Address,
      abi: factoryAbi,
      eventName: "TokenLaunched",
      args: { deployer: config.wallets.creator as Address },
      fromBlock,
      toBlock,
      strict: true,
    }),
  );
  const launches = await Promise.all(
    logs.map(async (log) => {
      const address = log.args.token;
      const [name, symbol] = await Promise.all([
        rpc.readContract({ address, abi: tokenAbi, functionName: "name" }),
        rpc.readContract({ address, abi: tokenAbi, functionName: "symbol" }),
      ]);
      const recognized =
        config.tokens.some(
          (token) => token.address.toLowerCase() === address.toLowerCase(),
        ) ||
        Object.keys(config.variantMeta).some((id) =>
          matchesVariant(id, name, symbol),
        );
      if (!recognized) return null;
      const quote = await tokenSnapshot(rpc, address);
      return {
        address,
        block: Number(log.blockNumber),
        name,
        symbol,
        pool: quote.pool,
        isToken0: quote.isToken0,
        curve: quote.curve,
        phase: quote.phase,
        poolId: quote.poolId,
      };
    }),
  );
  return launches.filter((launch) => launch !== null);
}
export function creatorAccrual(
  pending: bigint,
  fee: bigint,
  tax: bigint,
  protocolShare: number,
) {
  const share = BigInt(protocolShare);
  return (
    fee - (((pending + fee) * share) / BPS - (pending * share) / BPS) + tax
  );
}
export async function readTokenTrades(
  rpc: Rpc,
  tokens: Token[],
  from: bigint,
  to: bigint,
  roundOpeningBlock?: number,
): Promise<Swap[]> {
  const result: Swap[] = [];
  const recipientSetups: number[] = [];
  const opening = roundOpeningBlock ?? config.round.startBlock ?? undefined;
  const transactionSenders = new Map<Hex, Address>();
  for (const token of tokens) {
    if (BigInt(token.launchBlock) > to) continue;
    const launch = await launchInfo(rpc, token.address);
    const policy = await rpc.readContract({
      address: config.factory as Address,
      abi: factoryAbi,
      functionName: "getLaunchFeePolicy",
      args: [token.address],
    });
    const begin =
      from > BigInt(token.launchBlock) ? from : BigInt(token.launchBlock);
    const curveLogs = (
      await bounded(begin, to, (fromBlock, toBlock) =>
        rpc.getContractEvents({
          address: launch.curve,
          abi: curveAbi,
          fromBlock,
          toBlock,
          strict: true,
        }),
      )
    ).sort(
      (a, b) =>
        Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
    );
    let pending = 0n,
      pendingTax = 0n;
    if (begin > BigInt(token.launchBlock) && curveLogs.length)
      [pending, pendingTax] = await Promise.all([
        rpc.readContract({
          address: launch.curve,
          abi: curveAbi,
          functionName: "quoteFeeBalance",
          blockNumber: begin - 1n,
        }),
        rpc.readContract({
          address: launch.curve,
          abi: curveAbi,
          functionName: "creatorTaxBalance",
          blockNumber: begin - 1n,
        }),
      ]);
    const verified = !launch.buybackEnabled;
    let collectionRecipient = true;
    if (curveLogs.length || launch.phase === 2) {
      const opening = await launchInfo(
        rpc,
        token.address,
        begin > BigInt(token.launchBlock) ? begin - 1n : begin,
      );
      collectionRecipient =
        opening.creatorFeeRecipient.toLowerCase() ===
        config.fees.collectionWallet.toLowerCase();
    }
    const common = (block: bigint, logIndex: number, tx: Hex) => ({
      token: token.id,
      family: token.family,
      block: Number(block),
      logIndex,
      ts: 0,
      tx,
    });
    for (const log of curveLogs) {
      if (log.eventName === "CreatorFeeRecipientUpdated") {
        const beforeGame =
          log.blockNumber < BigInt(opening ?? Number.MAX_SAFE_INTEGER);
        if (
          !beforeGame ||
          collectionRecipient ||
          pending !== 0n ||
          pendingTax !== 0n ||
          log.args.previousRecipient.toLowerCase() !==
            config.wallets.creator?.toLowerCase() ||
          log.args.newRecipient.toLowerCase() !==
            config.fees.collectionWallet.toLowerCase()
        )
          throw Error("Fee policy changed; historical reconciliation required");
        collectionRecipient = true;
        recipientSetups.push(Number(log.blockNumber));
        continue;
      }
      if (log.eventName === "BuybackEnabledUpdated")
        throw Error("Fee policy changed; historical reconciliation required");
      if (log.eventName === "FeesSwept" || log.eventName === "FeesRescued") {
        pending = 0n;
        pendingTax = 0n;
        continue;
      }
      if (log.eventName !== "CurveBuy" && log.eventName !== "CurveSell")
        continue;
      const args = log.args,
        buy = log.eventName === "CurveBuy";
      const fee = creatorAccrual(
        pending,
        args.fee,
        args.tax,
        policy.protocolFeeShareBps,
      );
      pending += args.fee;
      pendingTax += args.tax;
      const payer = "buyer" in args ? args.buyer : args.seller;
      result.push({
        ...common(log.blockNumber, log.logIndex, log.transactionHash),
        kind: "trade",
        volume:
          "quoteIn" in args
            ? args.quoteIn
            : args.quoteOut + args.fee + args.tax,
        tokenAmountWei: "tokensOut" in args ? args.tokensOut : args.tokensIn,
        side: buy ? "buy" : "sell",
        wallet: buy ? args.recipient : payer,
        payer,
        recipient: args.recipient,
        creatorFeeWei: verified && collectionRecipient ? fee : 0n,
        feeVerified: verified,
      });
    }
    if (launch.phase < 2) continue;
    if (!collectionRecipient)
      throw Error("Graduated recipient history requires reconciliation");
    const id = v4PoolId(
      token.address,
      launch.pairToken,
      launch.poolFee,
      launch.tickSpacing,
    );
    const manager = await poolManager(rpc);
    const swaps = await bounded(begin, to, (fromBlock, toBlock) =>
      rpc.getContractEvents({
        address: manager,
        abi: poolAbi,
        eventName: "Swap",
        args: { id },
        fromBlock,
        toBlock,
        strict: true,
      }),
    );
    const hookEvents = hookAbi.filter((item) => item.type === "event");
    const hooks = await bounded(begin, to, async (fromBlock, toBlock) => {
      const logs = await rpc.request({
        method: "eth_getLogs",
        params: [
          {
            address: config.protocol.hook as Address,
            topics: [hookEvents.map(toEventSelector), id],
            fromBlock: toHex(fromBlock),
            toBlock: toHex(toBlock),
          },
        ],
      });
      return parseEventLogs({
        abi: hookAbi,
        logs: logs.map((log) => formatLog(log)),
        strict: true,
      });
    });
    const relevant = hooks.filter((l) => l.args.poolId === id);
    if (!swaps.length && !relevant.length) continue;
    let nativeFee = 0n,
      nativeTax = 0n;
    if (begin > BigInt(token.launchBlock))
      [nativeFee, nativeTax] = await Promise.all([
        rpc.readContract({
          address: config.protocol.hook as Address,
          abi: hookAbi,
          functionName: "pendingFees",
          args: [id, zeroAddress],
          blockNumber: begin - 1n,
        }),
        rpc.readContract({
          address: config.protocol.hook as Address,
          abi: hookAbi,
          functionName: "pendingCreatorTax",
          args: [id, zeroAddress],
          blockNumber: begin - 1n,
        }),
      ]);
    const ordered = [...swaps, ...relevant].sort(
      (a, b) =>
        Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
    );
    for (const log of ordered) {
      if (log.eventName === "Swap") {
        const a = log.args;
        if (a.sender.toLowerCase() === config.protocol.hook.toLowerCase())
          continue;
        let payer = transactionSenders.get(log.transactionHash);
        if (!payer) {
          payer = (await rpc.getTransaction({ hash: log.transactionHash }))
            .from;
          transactionSenders.set(log.transactionHash, payer);
        }
        result.push({
          ...common(log.blockNumber, log.logIndex, log.transactionHash),
          kind: "trade",
          volume: abs(a.amount0),
          tokenAmountWei: abs(a.amount1),
          side: a.amount0 < 0n ? "buy" : "sell",
          wallet: payer,
          payer,
          creatorFeeWei: 0n,
          feeVerified: verified,
        });
        continue;
      }
      if (
        log.eventName === "BuybackEnabledUpdated" ||
        log.eventName === "CreatorFeeRecipientUpdated"
      )
        throw Error("Fee policy changed; historical reconciliation required");
      let credit = 0n;
      if (
        log.eventName === "HookFeeCollected" &&
        log.args.currency === zeroAddress
      ) {
        credit = creatorAccrual(
          nativeFee,
          log.args.feeAmount,
          log.args.taxAmount,
          policy.protocolFeeShareBps,
        );
        nativeFee += log.args.feeAmount;
        nativeTax += log.args.taxAmount;
      } else if (log.eventName === "PoolFeesSwept") {
        const accrued =
          nativeFee -
          (nativeFee * BigInt(policy.protocolFeeShareBps)) / BPS +
          nativeTax;
        credit = log.args.creatorAmount - accrued;
        if (credit < 0n || log.args.buybackAmount !== 0n)
          throw Error("Fee sweep differs from recognized entitlement");
        nativeFee = 0n;
        nativeTax = 0n;
      } else if (log.eventName === "PoolFeesRescued") {
        if (log.args.quoteToken === zeroAddress) {
          nativeFee = 0n;
          nativeTax = 0n;
        } else throw Error("Non-native fee rescue requires reconciliation");
      }
      if (credit)
        result.push({
          ...common(log.blockNumber, log.logIndex, log.transactionHash),
          kind: "fee-credit",
          volume: 0n,
          side: "sell",
          wallet: config.fees.collectionWallet as Address,
          creatorFeeWei: verified ? credit : 0n,
          feeVerified: verified,
        });
    }
  }
  result.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const first =
    opening ??
    (config.round.startMode === "first-family-trade" && !config.testMode
      ? result.find(
          (s) =>
            s.family &&
            s.volume > 0n &&
            s.feeVerified &&
            s.kind !== "fee-credit",
        )?.block
      : undefined);
  if (first !== undefined && recipientSetups.some((block) => block >= first))
    throw Error(
      "Fee recipient setup occurred during active rounds; reconciliation required",
    );
  return result;
}
function logRangeError(error: unknown) {
  const messages: string[] = [],
    visited = new Set<unknown>();
  for (
    let current = error;
    current && typeof current === "object" && !visited.has(current);
  ) {
    visited.add(current);
    const item = current as {
      code?: unknown;
      status?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      [item.code, item.status].some(
        (code) =>
          typeof code === "number" &&
          [401, 403, 408, 429, 500, 502, 503, 504].includes(code),
      )
    )
      return false;
    for (const value of [item.shortMessage, item.details, item.message])
      if (typeof value === "string") messages.push(value);
    current = item.cause;
  }
  const message = messages.join("\n");
  if (
    /rate[ -]?limit|too many requests|unauthori[sz]ed|forbidden|access denied|historical state|missing trie|timed? ?out|timeout|network|fetch failed/i.test(
      message,
    )
  )
    return false;
  return /(?:block\s+)?ranges?[^\n]*(?:limit|exceed|too (?:large|wide)|over\s+\d|not supported|unsupported)|(?:query|request)[^\n]*(?:more than|exceed)[^\n]*(?:results|logs)|(?:results?|response)[^\n]*(?:too large|size[^\n]*(?:limit|exceed))|too many (?:results|logs)/i.test(
    message,
  );
}
export async function bounded<T>(
  from: bigint,
  to: bigint,
  read: (from: bigint, to: bigint) => Promise<T[]>,
  max = 100n,
) {
  if (max < 1n)
    throw new RangeError("Log range must contain at least one block");
  type Range = { from: bigint; to: bigint };
  const pending: Range[] = [],
    pages: { from: bigint; values: T[] }[] = [],
    order = (a: { from: bigint }, b: { from: bigint }) =>
      a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
  let cursor = from,
    chunk = max > 100n ? 100n : max;
  while (cursor <= to || pending.length) {
    const ranges: Range[] = [];
    while (ranges.length < 3 && (cursor <= to || pending.length)) {
      const range = pending.shift() ?? { from: cursor, to };
      const end =
        range.from + chunk - 1n > range.to ? range.to : range.from + chunk - 1n;
      ranges.push({ from: range.from, to: end });
      if (range.from === cursor) cursor = end + 1n;
      else if (end < range.to)
        pending.unshift({ from: end + 1n, to: range.to });
    }
    const results = await Promise.allSettled(
      ranges.map(async (range) => read(range.from, range.to)),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (
        result.status === "rejected" &&
        (ranges[i].from === ranges[i].to || !logRangeError(result.reason))
      )
        throw result.reason;
    }
    for (let i = 0; i < results.length; i++) {
      const result = results[i],
        range = ranges[i];
      if (result.status === "fulfilled") {
        pages.push({ from: range.from, values: result.value });
      } else {
        const smaller = (range.to - range.from + 1n) / 2n || 1n;
        if (smaller < chunk) chunk = smaller;
        pending.push(range);
      }
    }
    pending.sort(order);
  }
  return pages.sort(order).flatMap((page) => page.values);
}
