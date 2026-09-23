import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  config,
  productionReady,
  roundsReady,
  thresholdFor,
} from "../packages/core/src/index";
import {
  publicStateSchema,
  type PublicState,
} from "../packages/core/src/state";
import { parseEther } from "viem";
import { run } from "./cli";

type Mode = "live" | "monitoring" | "prelaunch";
type Check = {
  name: string;
  status: "pass" | "fail" | "warning";
  detail: string;
};
type Report = {
  checkedAt: string;
  expectedMode: Mode;
  passed: boolean;
  checks: Check[];
};
type Fetcher = typeof fetch;

export function publicOrigin(value: string, site = false) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("Provide an absolute public HTTPS release origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      "Public release origins must use HTTPS without credentials, query strings or fragments.",
    );
  if (site && url.pathname !== "/")
    throw Error("The site URL must be an origin without a path.");
  return url.toString().replace(/\/$/, "");
}

export function dataHeaders(headers: Headers, origin: string) {
  const allow = headers.get("access-control-allow-origin");
  const cache = headers.get("cache-control") || "";
  const lifetimes = [
    ...cache.matchAll(/(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/gi),
  ].map((match) => Number(match[1]));
  return {
    json: /application\/json/i.test(headers.get("content-type") || ""),
    cors: allow === "*" || allow === origin,
    cache:
      /(?:^|,)\s*public(?:,|$)/i.test(cache) &&
      lifetimes.length > 0 &&
      lifetimes.every((seconds) => seconds <= 4) &&
      !/private|no-store/i.test(cache),
  };
}

export function stateIssues(
  state: PublicState,
  expected: Mode,
  now = Math.floor(Date.now() / 1000),
) {
  const issues: string[] = [];
  const mode = expected === "prelaunch" ? "unconfigured" : expected;
  if (state.mode !== mode)
    issues.push("Published mode differs from the requested release mode.");
  if (expected !== "prelaunch") {
    if (
      state.updatedAt <= 0 ||
      now - state.updatedAt > 180 ||
      state.updatedAt - now > 60 ||
      state.stale
    )
      issues.push("Published state is stale, undated or ahead of the clock.");
    if (state.headBlock <= 0)
      issues.push("No verified chain head is published.");
    for (const token of config.tokens)
      if (
        !state.tokens.some(
          (row) =>
            row.id === token.id &&
            row.address.toLowerCase() === token.address.toLowerCase(),
        )
      )
        issues.push("Configured token absent or mismatched: " + token.id + ".");
    if (state.kitchen.supplyLeftWei === null)
      issues.push("Verified EGG supply is missing.");
  }
  if (expected === "live") {
    if (!productionReady())
      issues.push("Local production configuration is incomplete.");
    if (
      state.round.startBlock < Number(config.round.startBlock) ||
      state.round.startBlock > state.headBlock
    )
      issues.push("Active round block range conflicts with configuration.");
    if (state.feed.generatedRoundWei === null)
      issues.push("Current round fee accounting is unverified.");
    if (!state.feed.accountingReady)
      issues.push("Payout accounting is still catching up.");
    if (
      !state.feed.collection ||
      state.feed.collection.status === "backfilling" ||
      state.feed.collection.throughBlock !== state.headBlock
    )
      issues.push(
        "Collection receipt coverage has not reached the indexed head.",
      );
    if (
      roundsReady() &&
      state.round.threshold !==
        thresholdFor(
          parseEther(String(config.round.firstThresholdEth)),
          state.round.growthSteps + 1,
        ).toString()
    )
      issues.push("Published round threshold conflicts with configuration.");
  }
  return issues;
}

function assetsRequired() {
  const variants = config.families.flatMap((family) => family.variants);
  const characters = [
    ...config.tokens.map((token) => token.id),
    ...variants,
    "feed-bag",
    "feed-bag-8lb",
    "feed-bag-bulk",
  ];
  const names = [
    ...[...characters, "brand-logo"].flatMap((id) =>
      [256, 512, 1024].flatMap((width) =>
        ["webp", "avif"].map((format) => id + "-" + width + "." + format),
      ),
    ),
    ...variants.map((id) => id + "-locked.webp"),
    ...[512, 1024, 1920, 2560, 3840].flatMap((width) =>
      ["webp", "avif"].map((format) => "banner-" + width + "." + format),
    ),
    "nest-1024.webp",
    "kitchen-1024.webp",
    "cook-egg-512.webp",
    "brand-favicon.ico",
    "brand-icon-32.png",
    "brand-icon-192.png",
    "brand-icon-512.png",
    "apple-touch-icon.png",
    "brand-maskable.png",
    "brand-social.png",
  ];
  return [...new Set(names)];
}

async function pooled<T>(items: T[], work: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) await work(items[cursor++]);
    }),
  );
}

export async function verifyRelease(
  options: { site: string; assets: string; data: string; mode: Mode },
  fetcher: Fetcher = fetch,
): Promise<Report> {
  const report: Report = {
    checkedAt: new Date().toISOString(),
    expectedMode: options.mode,
    passed: false,
    checks: [],
  };
  const add = (name: string, status: Check["status"], detail: string) =>
    report.checks.push({ name, status, detail });
  const request = async (name: string, url: string, init: RequestInit = {}) => {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        add(name, "fail", "HTTP " + response.status + ".");
        await response.body?.cancel();
        return null;
      }
      return response;
    } catch {
      add(name, "fail", "Request failed, redirected or timed out.");
      return null;
    }
  };
  const origins = {
    site: publicOrigin(options.site, true),
    assets: publicOrigin(options.assets),
    data: publicOrigin(options.data),
  };
  const next = await readFile("apps/web/next.config.ts", "utf8");
  const server = await readFile("scripts/serve.ts", "utf8");
  const exportCorrect =
    /output:\s*["']export["']/.test(next) &&
    next.includes('".next-build"') &&
    server.includes("apps/web/.next-build");
  add(
    "static export configuration",
    exportCorrect ? "pass" : "fail",
    exportCorrect
      ? "Build and preview use apps/web/.next-build."
      : "Static export directory mismatch.",
  );
  try {
    await stat("apps/web/.next-build/index.html");
    add("local static export", "pass", "Current export exists.");
  } catch {
    add(
      "local static export",
      "fail",
      "Run npm run build; apps/web/.next-build/index.html is absent.",
    );
  }
  try {
    await stat("apps/web/out/index.html");
    add(
      "obsolete export",
      "warning",
      "apps/web/out exists and must not be selected as the Pages output directory.",
    );
  } catch {}
  add(
    "configuration",
    options.mode !== "live" || productionReady() ? "pass" : "fail",
    options.mode === "live"
      ? "Live release requires complete production parameters."
      : "This check does not activate rounds or financial execution.",
  );

  const stateResponse = await request(
    "public state",
    origins.data + "/state.json",
    { headers: { Origin: origins.site } },
  );
  if (stateResponse) {
    const headers = dataHeaders(stateResponse.headers, origins.site);
    for (const [name, passed] of Object.entries(headers))
      add(
        "public state " + name,
        passed ? "pass" : "fail",
        name === "cors"
          ? "The site origin must be allowed to read public data."
          : name === "cache"
            ? "Public state must retain a cache lifetime of at most four seconds."
            : "State must be served as JSON.",
      );
    try {
      const state = publicStateSchema.parse(await stateResponse.json());
      add(
        "public state schema",
        "pass",
        "Public state matches the supported schema.",
      );
      const issues = stateIssues(state, options.mode);
      add(
        "public state readiness",
        issues.length ? "fail" : "pass",
        issues.length
          ? issues.join(" ")
          : "Mode, freshness, token addresses and required accounting match the requested release.",
      );
    } catch {
      add(
        "public state schema",
        "fail",
        "State is malformed or does not match the supported schema.",
      );
    }
  }

  const assetProbe = await request(
    "asset manifest",
    origins.assets + "/manifest.json",
  );
  if (assetProbe) {
    try {
      const manifest = (await assetProbe.json()) as Record<string, unknown>;
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !manifest.banner ||
        !manifest.egg ||
        !manifest["brand-logo"]
      )
        throw Error();
      add(
        "asset manifest",
        "pass",
        "Processed banner, egg and brand entries are present.",
      );
      const missing: string[] = [];
      const required = assetsRequired();
      await pooled(required, async (file) => {
        try {
          const response = await fetcher(origins.assets + "/" + file, {
            method: "HEAD",
            redirect: "error",
            signal: AbortSignal.timeout(12000),
          });
          if (
            !response.ok ||
            !/^image\//i.test(response.headers.get("content-type") || "") ||
            response.headers.get("content-length") === "0"
          )
            missing.push(file);
        } catch {
          missing.push(file);
        }
      });
      add(
        "deployed artwork",
        missing.length ? "fail" : "pass",
        missing.length
          ? missing.length +
              " of " +
              required.length +
              " required images are missing or invalid: " +
              missing.sort().join(", ")
          : required.length +
              " required images are available with image content types.",
      );
    } catch {
      add(
        "asset manifest",
        "fail",
        "Processed asset manifest is missing required entries or is malformed.",
      );
    }
  }

  const home = await request("site homepage", origins.site + "/");
  if (home) {
    const html = await home.text();
    const configuredAddresses = config.tokens.every((token) =>
      html.toLowerCase().includes(token.address.toLowerCase()),
    );
    add(
      "site token addresses",
      configuredAddresses ? "pass" : "fail",
      "The deployed homepage must contain every configured original token address.",
    );
    add(
      "site asset origin",
      html.includes(origins.assets + "/brand-logo-") &&
        html.includes(origins.assets + "/banner-")
        ? "pass"
        : "fail",
      "Deployed header and hero must reference the configured public asset origin.",
    );
    const routes = [
      ["inventory", "INVENTORY"],
      ...config.families.map((family) => [
        "inventory/" + family.id,
        family.id.toUpperCase() + " COLLECTION",
      ]),
      ["feed", "THE FEED"],
      ["incubator", "THE INCUBATOR"],
      ["rounds", "THE ROUNDS"],
      ["kitchen", "THE KITCHEN"],
      ["check", "CHECK YOUR WALLET"],
      ["whitepaper", "CS2 CHICKENS"],
    ];
    await pooled(routes, async ([path, heading]) => {
      const response = await request(
        "route " + path,
        origins.site + "/" + path + "/",
      );
      if (!response) return;
      const body = await response.text();
      const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i
        .exec(body)?.[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
      add(
        "route " + path,
        h1?.includes(heading) ? "pass" : "fail",
        "Static route must return its own expected page heading.",
      );
    });
    const manifest = await request(
      "site manifest",
      origins.site + "/manifest.webmanifest",
    );
    if (manifest) {
      try {
        const value = (await manifest.json()) as { icons?: { src?: string }[] };
        add(
          "site icon origin",
          value.icons?.length &&
            value.icons.every((icon) =>
              icon.src?.startsWith(origins.assets + "/"),
            )
            ? "pass"
            : "fail",
          "App icons must reference the configured public asset origin.",
        );
      } catch {
        add("site manifest", "fail", "Web manifest is malformed.");
      }
    }
  }
  report.checks.sort((a, b) => a.name.localeCompare(b.name));
  report.passed = !report.checks.some((check) => check.status === "fail");
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      assets: { type: "string" },
      data: { type: "string" },
      mode: { type: "string", default: "live" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!["live", "monitoring", "prelaunch"].includes(values.mode!))
    throw Error("Choose --mode live, monitoring or prelaunch.");
  const report = await verifyRelease({
    site: values.site || "https://cs2chickens.fun",
    assets:
      values.assets ||
      process.env.NEXT_PUBLIC_ASSET_BASE ||
      "https://assets.cs2chickens.fun",
    data:
      values.data ||
      process.env.NEXT_PUBLIC_DATA_BASE ||
      "https://data.cs2chickens.fun",
    mode: values.mode as Mode,
  });
  await mkdir("private/verification", { recursive: true });
  await writeFile(
    "private/verification/release.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const check of report.checks)
    console.log(
      check.status.toUpperCase() + ": " + check.name + " — " + check.detail,
    );
  console.log("Release evidence: private/verification/release.json");
  console.log(
    report.passed
      ? "Public release checks passed. This is not transaction-execution approval."
      : "Public release checks failed. Do not describe this deployment as ready.",
  );
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run(main);
