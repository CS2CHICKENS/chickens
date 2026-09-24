"use client";
import { LinkArrow } from "./link-arrow";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { motion } from "motion/react";
import { config } from "../../../packages/core/src/index";
import { useGame } from "./data";
import { FamilyHelp } from "./help";
import { Art, Copy, Buy, Title, colors, human } from "./game";
export function Inventory({ family }: { family?: string }) {
  const { state, prices } = useGame();
  const [filter, setFilter] = useState("all");
  const families = config.families.filter((f) => !family || f.id === family);
  const variants = families.flatMap((f) =>
    f.variants.map((id) => ({ id, family: f.id })),
  );
  const defaults = config.tokens.filter(
    (t) => !family || ("family" in t && t.family === family),
  );
  return (
    <div className="page">
      <Title
        eyebrow="SEASON 01 / INVENTORY"
        title={family ? family.toUpperCase() + " COLLECTION" : "INVENTORY"}
        detail="Every variant has a place. Every launch has proof."
      />
      <FamilyHelp />
      <div className="inventory-toolbar">
        <div className="tabs">
          <Link href="/inventory" aria-current={!family ? "page" : undefined}>
            ALL ITEMS
          </Link>
          {config.families.map((f) => (
            <Link
              key={f.id}
              href={"/inventory/" + f.id}
              aria-current={family === f.id ? "page" : undefined}
            >
              {f.name.toUpperCase()}
            </Link>
          ))}
        </div>
        <label className="filter">
          SHOW{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">ALL ITEMS</option>
            <option value="live">LAUNCHED</option>
            <option value="locked">LOCKED</option>
          </select>
        </label>
      </div>
      <div className="inventory">
        {[
          ...defaults.map((t) => ({
            id: t.id,
            family: "family" in t ? t.family : "base",
          })),
          ...variants,
        ].map((item) => {
          const live = state.tokens.find((t) => t.id === item.id);
          const base = config.tokens.find((t) => t.id === item.id);
          const launched = !!base || !!live;
          const hatched = state.history.hatches.some(
            (h) => h.variant === item.id,
          );
          if (
            (filter === "live" && !launched) ||
            (filter === "locked" && launched)
          )
            return null;
          const address = base?.address || live?.address;
          const price = live?.priceEth ?? prices[item.id];
          const meta =
            config.variantMeta[item.id as keyof typeof config.variantMeta];
          return (
            <motion.article
              whileHover={{ y: -5, rotateX: 3 }}
              className={
                "item " +
                (!launched && !hatched ? "locked " : "") +
                (meta?.rarity === "covert" ? "covert" : "")
              }
              key={item.id}
              style={
                {
                  "--family": colors[item.family || "base"] || "#b0c3d9",
                } as CSSProperties
              }
            >
              <div className="item-top">
                <span>
                  {launched ? "IN PLAY" : hatched ? "HATCHED" : "LOCKED"}
                </span>
                <span>{meta?.rarity || "DEFAULT"}</span>
              </div>
              <Link
                className="item-art-link"
                href={"/tokens/" + item.id}
                aria-label={"View " + human(item.id) + " details"}
              >
                <Art id={item.id} locked={!launched && !hatched} />
              </Link>
              <div className="item-info">
                <span className="eyebrow">
                  {item.family === "base"
                    ? "BASE TOKEN"
                    : item.family?.toUpperCase() + " COLLECTION"}
                </span>
                <h2>
                  {item.id.includes("-")
                    ? human(
                        item.id.slice((item.family?.length || 0) + 1),
                      ).toUpperCase()
                    : item.id.toUpperCase()}
                </h2>
                <span className="eyebrow">{base?.symbol ?? meta?.symbol}</span>
                <Link
                  className="text-link token-details-link"
                  href={"/tokens/" + item.id}
                >
                  TOKEN DETAILS <LinkArrow />
                </Link>
                {launched ? (
                  <>
                    <dl>
                      <div>
                        <dt>PRICE</dt>
                        <dd>
                          {price !== undefined
                            ? price.toPrecision(3) + " ETH"
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>MCAP</dt>
                        <dd>
                          {live?.marketCapUsd != null
                            ? "$" +
                              live.marketCapUsd.toLocaleString("en-US", {
                                maximumFractionDigits: 0,
                              })
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>ROUND VOL.</dt>
                        <dd>
                          {live &&
                          (state.mode === "live" || state.mode === "demo")
                            ? live.volumeRoundEth.toFixed(2) + " ETH"
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>HOLDERS</dt>
                        <dd>{live?.holders ?? "—"}</dd>
                      </div>
                    </dl>
                    <div className="graduation">
                      <span>GRADUATION</span>
                      <span>
                        {live
                          ? (live.graduationProgress * 100).toFixed(1) + "%"
                          : "—"}
                      </span>
                    </div>
                    <div className="track">
                      <i
                        style={{
                          transform:
                            "scaleX(" + (live?.graduationProgress || 0) + ")",
                        }}
                      />
                    </div>
                    {address && (
                      <>
                        <Copy value={address} />
                        <Buy address={address} />
                      </>
                    )}
                  </>
                ) : (
                  <p className="locked-label">
                    {hatched ? "AWAITING OFFICIAL LAUNCH" : "AWAITING A HATCH"}
                    <br />
                    <small>
                      {hatched
                        ? "Its verified address appears after launch."
                        : "Cosmetic rarity · equal hatch odds"}
                    </small>
                  </p>
                )}
              </div>
            </motion.article>
          );
        })}
      </div>
    </div>
  );
}
