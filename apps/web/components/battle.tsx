"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import { motion } from "motion/react";
import { config } from "../../../packages/core/src/index";
import { useGame } from "./data";
import { Art, colors, eth, human, RoundHud, explorer, short } from "./game";
import { FamilyHelp } from "./help";

export function FamilyBattle() {
  const { state, delayed } = useGame();
  const families = [...config.families].sort((a, b) => {
    const x = BigInt(state.round.volumeByFamily[a.id] || "0"),
      y = BigInt(state.round.volumeByFamily[b.id] || "0");
    return x === y ? a.id.localeCompare(b.id) : x > y ? -1 : 1;
  });
  const total = families.reduce(
    (sum, f) => sum + BigInt(state.round.volumeByFamily[f.id] || "0"),
    0n,
  );
  const top = BigInt(state.round.volumeByFamily[families[0].id] || "0");
  const tied =
    families.filter(
      (f) => BigInt(state.round.volumeByFamily[f.id] || "0") === top,
    ).length > 1;
  const known =
    (state.mode === "live" || state.mode === "demo") && state.updatedAt > 0;
  return (
    <section className="family-battle">
      <RoundHud />
      <div className="section-label spacious">
        <h2>FAMILY VOLUME BATTLE</h2>
        <span>
          {!known
            ? "AWAITING ACTIVATION"
            : state.mode === "demo"
              ? "SIMULATION"
              : delayed
                ? "LAST KNOWN STATE"
                : "LIVE · UPDATES EVERY FEW SECONDS"}
        </span>
      </div>
      <p className="battle-intro">
        One family. Every chicken counts. The original and all its launched
        variants compete together.
      </p>
      <FamilyHelp />
      <div className="battle-families">
        {families.map((f, index) => {
          const volume = BigInt(state.round.volumeByFamily[f.id] || "0");
          const share = total ? Number((volume * 10000n) / total) / 100 : 0;
          const members = [
            f.id,
            ...f.variants.filter(
              (id) =>
                state.tokens.some((t) => t.id === id && t.family === f.id) ||
                state.history.hatches.some(
                  (h) => h.variant === id && h.family === f.id,
                ),
            ),
          ];
          const wins =
            state.history.wins?.[f.id] ??
            state.history.rounds.filter((r) => r.winner === f.id).length;
          return (
            <article
              key={f.id}
              className="battle-family"
              data-family={f.id}
              style={{ "--family": colors[f.id] } as CSSProperties}
            >
              <header className="battle-heading">
                <div>
                  <span className="eyebrow">
                    {!known || !top
                      ? "READY TO COMPETE"
                      : index === 0 && !tied
                        ? "LEADING THE ROUND"
                        : volume === top && tied
                          ? "TIED FOR THE LEAD"
                          : "CHASING THE LEAD"}
                  </span>
                  <h3>
                    {f.name.toUpperCase()}{" "}
                    <small>
                      {wins} {wins === 1 ? "WIN" : "WINS"}
                    </small>
                  </h3>
                </div>
                <div className="battle-total">
                  <strong className="digits">
                    {known ? eth(volume, 3) : "—"} <small>ETH</small>
                  </strong>
                  <span>COMBINED FAMILY VOLUME</span>
                </div>
              </header>
              <div className="battle-bar">
                <motion.div
                  initial={false}
                  animate={{ width: share + "%" }}
                  transition={{ duration: 0.65 }}
                />
              </div>
              <div className="battle-share">
                <span>{share.toFixed(1)}% OF ALL FAMILY VOLUME</span>
                <Link href={"/inventory/" + f.id}>VIEW FAMILY ↗</Link>
              </div>
              <div className="battle-lineup">
                {members.map((id) => {
                  const isBase = id === f.id;
                  const token = state.tokens.find(
                    (t) => t.id === id && t.family === f.id,
                  );
                  const hatch = state.history.hatches.find(
                    (h) => h.variant === id && h.family === f.id,
                  );
                  const launched = isBase || !!token;
                  const value = state.round.volumeByToken[id];
                  return (
                    <div
                      className={
                        "battle-member " + (!launched ? "pending-member" : "")
                      }
                      key={id}
                      data-token={id}
                    >
                      <Art id={id} />
                      <span className="eyebrow">
                        {isBase
                          ? "ORIGINAL"
                          : hatch
                            ? "HATCHED · ROUND " + hatch.round
                            : "LAUNCHED VARIANT"}
                      </span>
                      <strong>
                        {isBase ? f.name : human(id.slice(f.id.length + 1))}
                      </strong>
                      <span className="digits">
                        {!launched
                          ? "AWAITING LAUNCH"
                          : known
                            ? eth(value || "0", 3) + " ETH"
                            : "VOLUME PENDING"}
                      </span>
                      <small>
                        {launched
                          ? "Adds to the family total"
                          : "Volume starts after launch"}
                      </small>
                    </div>
                  );
                })}
              </div>
              <p className="battle-equation">
                ORIGINAL + ALL LAUNCHED VARIANTS = ONE FAMILY SCORE
              </p>
            </article>
          );
        })}
      </div>
      <div className="battle-activity panel">
        <div className="section-label">
          <h2>LATEST FAMILY TRADES</h2>
          <span>BUYS + SELLS COUNT</span>
        </div>
        {state.ticker
          .filter((t) =>
            config.families.some(
              (f) =>
                t.token === f.id ||
                (f.variants as readonly string[]).includes(t.token),
            ),
          )
          .slice(0, 6)
          .map((t, i) => (
            <a
              className="battle-trade"
              key={t.tx + i}
              href={explorer + "/tx/" + t.tx}
            >
              <span>{human(t.token).toUpperCase()}</span>
              <span>{t.side.toUpperCase()}</span>
              <strong className="digits">{t.ethAmount.toFixed(3)} ETH</strong>
              <span>{short(t.tx)} ↗</span>
            </a>
          ))}
        {!state.ticker.some((t) =>
          config.families.some(
            (f) =>
              t.token === f.id ||
              (f.variants as readonly string[]).includes(t.token),
          ),
        ) && (
          <p className="panel-note">
            Family trades will appear here once confirmed and indexed.
          </p>
        )}
      </div>
    </section>
  );
}
