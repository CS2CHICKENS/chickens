import type { Env } from "./index";
import { alert } from "./storage";
import { LedgerBusy } from "./lease";
import { warnWorkFailure } from "./diagnostics";

export const workKinds = [
  "index",
  "settlement",
  "publication",
  "wallets",
  "fees",
] as const;
export type WorkKind = (typeof workKinds)[number];
export type WorkMessage = { kind: WorkKind; token: string };

export async function scheduleWork(env: Env, kind: WorkKind) {
  if (!env.WORK) return;
  const now = Math.floor(Date.now() / 1000),
    token = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    "INSERT INTO work_jobs(kind,token,sentAt) VALUES(?,?,?) ON CONFLICT(kind) DO NOTHING RETURNING token",
  )
    .bind(kind, token, now)
    .first<{ token: string }>();
  let messageToken = inserted?.token;
  if (!messageToken) {
    const stale = await env.DB.prepare(
      "UPDATE work_jobs SET sentAt=? WHERE kind=? AND sentAt<? RETURNING token",
    )
      .bind(now, kind, now - 900)
      .first<{ token: string }>();
    messageToken = stale?.token;
  }
  if (!messageToken) return;
  try {
    await env.WORK.send({ kind, token: messageToken });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE work_jobs SET sentAt=0 WHERE kind=? AND token=?",
    )
      .bind(kind, messageToken)
      .run();
    throw error;
  }
}

export async function consumeWork(
  batch: MessageBatch<WorkMessage>,
  env: Env,
  execute: (kind: WorkKind) => Promise<boolean>,
) {
  for (const message of batch.messages) {
    const body = message.body;
    if (
      !body ||
      !workKinds.includes(body.kind) ||
      typeof body.token !== "string"
    ) {
      message.ack();
      continue;
    }
    const job = await env.DB.prepare("SELECT token FROM work_jobs WHERE kind=?")
      .bind(body.kind)
      .first<{ token: string }>();
    if (job?.token !== body.token) {
      message.ack();
      continue;
    }
    try {
      const more = await execute(body.kind);
      if (more) {
        if (!env.WORK) throw Error("Work queue binding missing");
        await env.WORK.send(body);
        await env.DB.prepare(
          "UPDATE work_jobs SET sentAt=? WHERE kind=? AND token=?",
        )
          .bind(Math.floor(Date.now() / 1000), body.kind, body.token)
          .run();
      } else {
        await env.DB.prepare("DELETE FROM work_jobs WHERE kind=? AND token=?")
          .bind(body.kind, body.token)
          .run();
      }
      message.ack();
    } catch (error) {
      if (!(error instanceof LedgerBusy)) {
        warnWorkFailure(body.kind, error);
        await alert(
          env,
          "work-" + body.kind,
          "Background " +
            body.kind +
            " work needs a retry; confirmed progress is retained.",
        );
      }
      message.retry({ delaySeconds: error instanceof LedgerBusy ? 5 : 30 });
    }
  }
}
