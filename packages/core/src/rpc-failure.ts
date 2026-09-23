export type FailureCategory =
  | "io_context"
  | "budget"
  | "d1"
  | "r2"
  | "lease"
  | "timeout"
  | "rate_limit"
  | "range_limit"
  | "archive_unavailable"
  | "access_denied"
  | "network"
  | "http"
  | "rpc"
  | "unknown";

export type FailureSummary = {
  category: FailureCategory;
  httpStatus?: number;
  rpcCode?: number;
};

const methods = [
  "eth_chainId",
  "eth_blockNumber",
  "eth_getLogs",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
] as const;
export type RpcMethod = (typeof methods)[number] | "other";
export type RpcFailure = FailureSummary & {
  method: RpcMethod;
  provider: number;
};
export type RpcFailureObserver = (failure: RpcFailure) => void;

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.slice(0, 8192) : "";
}

function numericCode(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2147483648 &&
    value <= 2147483647
    ? value
    : undefined;
}

export function summarizeFailure(error: unknown): FailureSummary {
  const seen = new Set<unknown>();
  const labels: string[] = [];
  let current: unknown = error,
    httpStatus: number | undefined,
    rpcCode: number | undefined;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const status = field(current, "status"),
      code = numericCode(field(current, "code")),
      details = text(field(current, "details"));
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    )
      httpStatus = status;
    if (code !== undefined) rpcCode = code;
    labels.push(
      text(field(current, "name")),
      text(field(current, "message")),
      text(field(current, "shortMessage")),
      text(field(current, "code")),
      details,
      typeof current === "string" ? current.slice(0, 8192) : "",
    );
    if (details.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(details),
          rpc = field(parsed, "error") ?? parsed,
          parsedCode = numericCode(field(rpc, "code"));
        if (parsedCode !== undefined) rpcCode = parsedCode;
        labels.push(text(field(rpc, "message")));
      } catch {
        // Diagnostic parsing must not affect the failed operation.
      }
    }
    current = field(current, "cause");
  }
  const description = labels.join("\n");
  let category: FailureCategory = "unknown";
  if (
    /i\/o[^\n]*(?:different|another) request|i\/o[^\n]*request context|io context/i.test(
      description,
    )
  )
    category = "io_context";
  else if (
    /too many (?:subrequests|api requests|(?:d1 )?queries)|(?:cpu|memory)[^\n]*limit|configured work budget|(?:query|request|execution)[^\n]*budget/i.test(
      description,
    )
  )
    category = "budget";
  else if (
    /\bD1(?:_ERROR|_EXEC_ERROR|_TYPE_ERROR|\b)|\bSQLITE_/i.test(description)
  )
    category = "d1";
  else if (/\bR2(?:Error|_ERROR|\b)/i.test(description)) category = "r2";
  else if (
    /lease expired or changed|ledger update in progress/i.test(description)
  )
    category = "lease";
  else if (/timeout|timed out|deadline exceeded/i.test(description))
    category = "timeout";
  else if (
    httpStatus === 429 ||
    rpcCode === 429 ||
    /rate limit|too many requests/i.test(description)
  )
    category = "rate_limit";
  else if (
    rpcCode === 35 ||
    /block range[^\n]*(?:limit|exceed)|ranges over[^\n]*blocks/i.test(
      description,
    )
  )
    category = "range_limit";
  else if (
    /historical state|missing trie node|state[^\n]*pruned/i.test(description)
  )
    category = "archive_unavailable";
  else if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    /unauthorized|forbidden/i.test(description)
  )
    category = "access_denied";
  else if (
    /fetch failed|failed to fetch|network|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(
      description,
    )
  )
    category = "network";
  else if (httpStatus !== undefined) category = "http";
  else if (rpcCode !== undefined) category = "rpc";
  return {
    category,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
  };
}

export function rpcFailure(
  error: unknown,
  method: unknown,
  provider: unknown,
): RpcFailure {
  return {
    ...summarizeFailure(error),
    method: methods.includes(method as (typeof methods)[number])
      ? (method as RpcMethod)
      : "other",
    provider:
      typeof provider === "number" &&
      Number.isInteger(provider) &&
      provider >= 1 &&
      provider <= 32
        ? provider
        : 0,
  };
}
