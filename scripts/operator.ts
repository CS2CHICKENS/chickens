import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { config, json } from "../packages/core/src/index";
import { OperatorTransactions } from "./operator-transactions";
import { run } from "./cli";
import type { Hex } from "viem";
export function localRequestAllowed(
  host: string | undefined,
  origin: string | undefined,
  expected: string,
) {
  return (
    host === new URL(expected).host &&
    (origin === undefined || origin === expected)
  );
}
export function createOperatorServer(
  service = new OperatorTransactions(),
  port = 8788,
) {
  const origin = "http://127.0.0.1:" + port;
  const token = Buffer.from(randomBytes(32)).toString("hex");
  let busy = false;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json(value));
    };
    if (!localRequestAllowed(req.headers.host, req.headers.origin, origin))
      return reply(403, { error: "Local origin required" });
    const path = new URL(req.url ?? "/", origin).pathname;
    try {
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(path)
      ) {
        const name = path === "/" ? "index.html" : path.slice(1);
        let body = await readFile("scripts/operator-ui/" + name, "utf8");
        if (path === "/") body = body.replace("__SESSION__", token);
        res.writeHead(200, {
          "content-type":
            path === "/"
              ? "text/html; charset=utf-8"
              : path.endsWith(".js")
                ? "text/javascript"
                : "text/css",
        });
        return res.end(body);
      }
      const provided = String(req.headers["x-operator-session"] ?? "");
      if (
        !/^[0-9a-f]{64}$/.test(provided) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
      )
        return reply(403, { error: "Local session required" });
      if (req.method === "GET" && path === "/api/status") {
        const files = await readdir(service.directory).catch(
          () => [] as string[],
        );
        const operations = [];
        for (const file of files.filter((file) => file.endsWith(".json"))) {
          const journal = await service.read(file.slice(0, -5));
          if (journal)
            operations.push({
              id: journal.proposal.id,
              label: journal.proposal.label,
              from: journal.proposal.from,
              tx: journal.tx ?? null,
              confirmed: !!journal.confirmed,
              reported: !!journal.reported,
            });
        }
        return reply(200, {
          chainId: config.chainId,
          wallets: config.wallets,
          operations,
          prepared: service.prepared
            ? {
                round: service.prepared.manifest.round,
                proof: service.prepared.proof,
              }
            : null,
        });
      }
      if (
        req.method !== "POST" ||
        req.headers.origin !== origin ||
        req.headers["content-type"] !== "application/json"
      )
        return reply(403, { error: "Local JSON request required" });
      if (busy) return reply(409, { error: "Another operation is running" });
      busy = true;
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) throw Error("Request too large");
        }
        const input = JSON.parse(body) as {
          round?: number;
          mode?: string;
          id?: string;
          tx?: string;
          proof?: string;
        };
        if (path === "/api/prepare")
          return reply(200, await service.prepare(Number(input.round)));
        if (path === "/api/next") {
          if (
            input.mode !== "deploy" &&
            (!service.prepared ||
              input.round !== service.prepared.manifest.round ||
              input.proof !== service.prepared.proof)
          )
            throw Error(
              "Recompute and verify the selected round before settlement.",
            );
          return reply(200, {
            proposal:
              input.mode === "deploy"
                ? await service.nextDeployment()
                : await service.nextSettlement(),
          });
        }
        if (
          path === "/api/confirm" &&
          input.id &&
          /^0x[0-9a-fA-F]{64}$/.test(input.tx ?? "")
        )
          return reply(200, await service.confirm(input.id, input.tx as Hex));
        if (path === "/api/cancel" && input.id) {
          await service.cancel(input.id);
          return reply(200, { cancelled: true });
        }
        if (path === "/api/retry-failed" && input.id) {
          await service.retryFailed(input.id);
          return reply(200, { retryReady: true });
        }
        return reply(404, { error: "Unknown operation" });
      } finally {
        busy = false;
      }
    } catch (error) {
      const reason = error as { shortMessage?: string; message?: string };
      const message = (
        reason.shortMessage ??
        reason.message ??
        "Operation failed"
      )
        .split("\n")[0]
        .replace(/https?:\/\/\S+/g, "[endpoint]")
        .replace(/[A-Za-z]:[\\/]\S+/g, "[local file]");
      return reply(400, { error: message });
    }
  });
}
async function main() {
  const build = spawnSync("forge", ["build", "--root", "contracts"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (build.status !== 0)
    throw Error(
      "Contract build failed. Install Foundry and run npm run test:contracts first.",
    );
  const server = createOperatorServer();
  server.on("error", () => {
    console.error("The local operator port is unavailable.");
    process.exitCode = 1;
  });
  server.listen(8788, "127.0.0.1", () =>
    console.log(
      "Open http://127.0.0.1:8788 in the browser where Rabby is installed. Keys stay in Rabby.",
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run(main);
