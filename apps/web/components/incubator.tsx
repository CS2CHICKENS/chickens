"use client";
import { useEffect, useState } from "react";
import { Scene } from "./scenes";
import { Explain } from "./help";
import { motion, AnimatePresence } from "motion/react";
import { useMotionPreference } from "./motion-preference";
import type { Hex } from "viem";
import { hatch, config } from "../../../packages/core/src/index";
import { useGame, assetBase } from "./data";
import { Art, Copy, Buy, Title, Timer, human, explorer } from "./game";
const previewHash = ("0x" + "1".repeat(64)) as Hex;
export function Incubator() {
  const { state } = useGame(),
    reduced = useMotionPreference();
  const [preview, setPreview] = useState(false),
    [selectedRound, setSelectedRound] = useState<number | null>(null),
    [selectionRequested, setSelectionRequested] = useState(false),
    [queryReady, setQueryReady] = useState(false),
    [queryError, setQueryError] = useState(""),
    [now, setNow] = useState(0),
    [phase, setPhase] = useState<"idle" | "shake" | "open" | "reveal">("idle"),
    [replay, setReplay] = useState(0);
  const previewIds = config.families[2].variants;
  useEffect(() => {
    const readSelection = () => {
      const raw = new URLSearchParams(window.location.search).get("round");
      const valid =
        raw !== null &&
        /^[1-9][0-9]*$/.test(raw) &&
        Number.isSafeInteger(Number(raw));
      setSelectionRequested(raw !== null);
      setSelectedRound(valid ? Number(raw) : null);
      setQueryError(
        raw !== null && !valid
          ? "This hatch link has an invalid round number. Choose a published round below."
          : "",
      );
      setQueryReady(true);
    };
    readSelection();
    window.addEventListener("popstate", readSelection);
    const updateClock = () => setNow(Math.floor(Date.now() / 1000));
    updateClock();
    const clock = setInterval(updateClock, 1000);
    return () => {
      window.removeEventListener("popstate", readSelection);
      clearInterval(clock);
    };
  }, []);
  useEffect(() => {
    if (!queryReady || selectionRequested) return;
    if (
      state.incubators.length &&
      !state.incubators.some((egg) => egg.round === selectedRound)
    )
      setSelectedRound(
        (state.incubators.find((egg) => egg.status === "incubating") ||
          state.incubators.at(-1))!.round,
      );
  }, [state.incubators, selectedRound, queryReady, selectionRequested]);
  const selected = state.incubators.find((egg) => egg.round === selectedRound);
  const selectionIssue =
    queryError ||
    (selectionRequested && selectedRound !== null && !selected
      ? state.updatedAt
        ? `Round ${selectedRound} has no published egg in the current record. No other round is shown in its place. Choose a published round below or check again after the data updates.`
        : `Round ${selectedRound} cannot be verified while public data is unavailable. This link will be checked again when the data returns.`
      : "");
  const inc = preview
    ? {
        status: "hatched",
        family: "silkie",
        hatchAt: 0,
        remaining: previewIds,
        result: {
          variant: hatch(previewHash, previewIds).variant,
          hash: previewHash,
          block: 0,
          tokenAddress: "",
        },
      }
    : selectionIssue || !queryReady
      ? { status: "idle", family: "", hatchAt: 0, remaining: [], result: null }
      : selected || state.incubator;
  const result = inc.result;
  const proofRound =
    selected?.round ??
    state.history.hatches.find(
      (egg) => egg.variant === result?.variant && egg.block === result?.block,
    )?.round;
  const proofUrl = proofRound
    ? `https://cs2chickens.fun/incubator/?round=${proofRound}`
    : "";
  const awaitingBlock =
    inc.status === "incubating" &&
    !result &&
    inc.hatchAt > 0 &&
    now >= inc.hatchAt;
  const deadline = inc.hatchAt
    ? new Date(inc.hatchAt * 1000)
        .toISOString()
        .replace("T", " ")
        .replace(".000Z", " UTC")
    : null;
  function selectRound(round: number) {
    setSelectedRound(round);
    setSelectionRequested(true);
    setQueryError("");
    if (round !== selectedRound) setPhase("idle");
    const url = new URL(window.location.href);
    url.searchParams.set("round", String(round));
    window.history.replaceState(window.history.state, "", url);
  }
  let proof: ReturnType<typeof hatch> | null = null;
  try {
    if (result) proof = hatch(result.hash as Hex, inc.remaining);
  } catch {}
  const valid = !!proof && proof.variant === result?.variant;
  useEffect(() => {
    if (!result || !valid) {
      setPhase("idle");
      return;
    }
    setPhase(reduced ? "reveal" : "shake");
    if (reduced) return;
    const opening = setTimeout(() => setPhase("open"), 2100),
      reveal = setTimeout(() => setPhase("reveal"), 3300);
    return () => {
      clearTimeout(opening);
      clearTimeout(reveal);
    };
  }, [
    result?.hash,
    result?.variant,
    selectedRound,
    preview,
    replay,
    reduced,
    valid,
  ]);
  const showPreview = process.env.NODE_ENV !== "production";
  return (
    <div className="page incubator-page">
      <Title
        eyebrow="SEASON 01 / THE NEST"
        title="THE INCUBATOR"
        detail="One egg. A new member of the family."
      />
      <Explain title="What happens after a family wins?">
        <p>
          If the family has variants left, an egg incubates for{" "}
          {config.round.incubationSec / 3600} hours. The published hatch-block
          formula selects the next variant. This chooses the new chicken, not a
          random cash prize.
        </p>
        <p>
          Trading never pauses for incubation. The next round starts at the next
          block and counts volume immediately. Several eggs can incubate at
          once, each for 10 hours from its own round's finish.
        </p>
        <p>
          After the hatch, the token must officially launch before trading it
          contributes to its family. The official address appears here once that
          launch is verified. A preview or replay does not start a new hatch.
        </p>
      </Explain>
      <p className="race-note">
        {state.mode === "live"
          ? `ROUND ${state.round.id} IS COUNTING TRADES · `
          : ""}
        Incubation does not pause the race.
      </p>
      {state.incubators.filter((egg) => egg.status === "incubating").length >
        1 &&
        !preview && (
          <section
            className="panel incubation-queue"
            aria-label="Upcoming chicken reveals"
          >
            <h2>UPCOMING CHICKEN REVEALS</h2>
            {state.incubators
              .filter((egg) => egg.status === "incubating")
              .map((egg) => (
                <button
                  className="button"
                  key={egg.round}
                  onClick={() => {
                    selectRound(egg.round);
                  }}
                >
                  <span>
                    ROUND {egg.round} · {egg.family.toUpperCase()} · REVEAL
                    IN{" "}
                  </span>
                  <Timer at={egg.hatchAt} />
                </button>
              ))}
          </section>
        )}
      {selectionIssue && !preview && (
        <p className="error" role="alert">
          {selectionIssue}
        </p>
      )}
      {(state.incubators.length > 0 || selectionIssue) && !preview && (
        <div className="incubator-selector">
          <label htmlFor="incubator-round">ROUND TO VIEW</label>
          <select
            id="incubator-round"
            value={selectedRound ?? ""}
            onChange={(event) => {
              selectRound(Number(event.target.value));
            }}
          >
            {!selected && (
              <option value={selectedRound ?? ""} disabled>
                {selectedRound
                  ? `ROUND ${selectedRound} · NOT AVAILABLE`
                  : "CHOOSE A PUBLISHED ROUND"}
              </option>
            )}
            {state.incubators.map((egg) => (
              <option key={egg.round} value={egg.round}>
                ROUND {egg.round} · {egg.family.toUpperCase()} ·{" "}
                {egg.status.toUpperCase()}
              </option>
            ))}
          </select>
          <p>
            Each winning round keeps its own egg and proof. Select a round to
            follow its countdown or replay its hatch.
          </p>
        </div>
      )}
      <section className="chamber nest-chamber">
        <div className="chamber-label">
          <span className="eyebrow">
            {preview
              ? "CINEMATIC PREVIEW · NOT A LIVE HATCH"
              : inc.family
                ? (selected ? "ROUND " + selected.round + " · " : "") +
                  inc.family.toUpperCase() +
                  " FAMILY"
                : selectionIssue
                  ? "REQUESTED ROUND UNAVAILABLE"
                  : "THE NEST IS READY"}
          </span>
          <span className="digits">
            {phase === "reveal"
              ? "A NEW CHICKEN HAS HATCHED"
              : phase === "shake" || phase === "open"
                ? "SOMETHING IS HATCHING"
                : awaitingBlock
                  ? "AWAITING CONFIRMED HATCH BLOCK"
                  : inc.status === "idle"
                    ? "WAITING FOR THE NEXT ROUND WINNER"
                    : "INCUBATION IN PROGRESS"}
          </span>
        </div>
        <Scene kind="nest">
          <div className="nest-stage">
            <AnimatePresence mode="sync">
              {phase === "reveal" && result && valid ? (
                <motion.div
                  key="chicken"
                  className="nest-chicken"
                  initial={{ opacity: 0, y: 65, scale: 0.4 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{
                    duration: reduced ? 0.15 : 1.15,
                    type: "spring",
                    bounce: 0.28,
                  }}
                >
                  <Art id={result.variant} eager />
                </motion.div>
              ) : phase === "open" ? (
                <div className="shells" key={"shells-" + replay}>
                  <motion.div
                    className="shell upper"
                    initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
                    animate={{ x: -65, y: -100, rotate: -35, opacity: 0 }}
                    transition={{ duration: 1.2 }}
                  >
                    <Art id="egg" eager />
                  </motion.div>
                  <motion.div
                    className="shell lower"
                    initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
                    animate={{ x: 50, y: 50, rotate: 25, opacity: 0 }}
                    transition={{ duration: 1.2 }}
                  >
                    <Art id="egg" eager />
                  </motion.div>
                </div>
              ) : (
                <motion.div
                  key={"egg-" + replay}
                  className="nest-egg"
                  animate={
                    reduced
                      ? {}
                      : phase === "shake"
                        ? {
                            rotate: [0, -2, 2, -4, 4, -6, 6, 0],
                            y: [0, 0, -3, 0, -5, 0, -8, 0],
                          }
                        : { y: [0, -3, 0], rotate: [0, 0.6, 0, -0.6, 0] }
                  }
                  transition={{
                    duration: phase === "shake" ? 0.55 : 4,
                    repeat: Infinity,
                  }}
                >
                  <Art id="egg" eager />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Scene>
        <div className="chamber-bottom">
          {phase === "reveal" && result && valid ? (
            <motion.div
              className="reveal-caption"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <span className="eyebrow">
                {config.variantMeta[
                  result.variant as keyof typeof config.variantMeta
                ]?.rarity?.toUpperCase() || "MIL-SPEC"}{" "}
                / {preview ? "PREVIEW" : "HATCH VERIFIED"}
              </span>
              <h2>
                {inc.family.toUpperCase()} |{" "}
                {human(
                  result.variant.slice(inc.family.length + 1),
                ).toUpperCase()}
              </h2>
              {result.tokenAddress ? (
                <>
                  <Copy value={result.tokenAddress} />
                  <Buy address={result.tokenAddress} />
                </>
              ) : (
                <p>
                  {preview
                    ? "The same cinematic reveals the real winning variant."
                    : "AWAITING OFFICIAL TOKEN LAUNCH · The next round is already counting trades."}
                </p>
              )}
            </motion.div>
          ) : (
            <>
              <span className="eyebrow">
                {phase === "idle"
                  ? inc.status === "idle"
                    ? selectionIssue
                      ? "REQUESTED HATCH UNAVAILABLE"
                      : "AWAITING A HATCH ROUND"
                    : awaitingBlock
                      ? "AWAITING CONFIRMED HATCH BLOCK"
                      : "NEXT CHICKEN REVEAL IN"
                  : "THE SHELL IS OPENING"}
              </span>
              <div className="countdown">
                {awaitingBlock || inc.status === "idle" ? (
                  <span className="digits">STAND BY</span>
                ) : phase === "idle" ? (
                  <Timer at={inc.hatchAt} />
                ) : (
                  <span className="digits">STAND BY</span>
                )}
              </div>
            </>
          )}
          {inc.status === "incubating" && deadline && (
            <p className="incubation-deadline">
              Target hatch time: {deadline}. The first confirmed block at or
              after this time determines the result. The reveal appears after
              that block is indexed; the timer does not guarantee an immediate
              token launch.
            </p>
          )}
          <div className="chamber-actions">
            {valid && (
              <button
                className="button"
                onClick={() => {
                  setPhase(reduced ? "reveal" : "shake");
                  setReplay((v) => v + 1);
                }}
              >
                REPLAY HATCH ↺
              </button>
            )}
            {showPreview && !preview && (
              <button className="button" onClick={() => setPreview(true)}>
                PREVIEW THE HATCH ↗
              </button>
            )}
            {preview && (
              <button
                className="button"
                onClick={() => {
                  setPreview(false);
                  setPhase("idle");
                }}
              >
                BACK TO LIVE
              </button>
            )}
            {valid && !preview && result && proofUrl && (
              <Copy value={proofUrl} />
            )}
            {valid && !preview && result && proofUrl && (
              <a
                className="button"
                href={
                  "https://twitter.com/intent/tweet?text=" +
                  encodeURIComponent(
                    human(result.variant) +
                      " hatched. Verify round " +
                      proofRound +
                      ", block " +
                      result.block +
                      " at " +
                      proofUrl,
                  )
                }
              >
                SHARE ON X ↗
              </a>
            )}
          </div>
        </div>
      </section>
      <section className="panel proof">
        <div className="section-label">
          <h2>VERIFY THE HATCH.</h2>
          <span>BLOCK HASH → MODULO → CHICKEN</span>
        </div>
        {result && !valid && !preview && (
          <p role="alert" className="error">
            Hatch proof mismatch. The reveal is blocked until verified data is
            available.
          </p>
        )}
        {result && proof && !preview ? (
          <>
            <dl>
              <div>
                <dt>BLOCK</dt>
                <dd>
                  <a href={explorer + "/block/" + result.block}>
                    {result.block} ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt>HASH</dt>
                <dd className="hash">{result.hash}</dd>
              </div>
              <div>
                <dt>INDEX</dt>
                <dd>
                  {proof.index} / {proof.ids.length} variants
                </dd>
              </div>
              <div>
                <dt>RESULT</dt>
                <dd>
                  {valid ? "VERIFIED" : "PROOF MISMATCH · REVEAL BLOCKED"}
                </dd>
              </div>
            </dl>
            <details>
              <summary>ASCII-sorted remaining variants</summary>
              <ol start={0}>
                {proof.ids.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ol>
            </details>
          </>
        ) : (
          <p>
            The first block at or after the {config.round.incubationSec / 3600}
            -hour incubation deadline chooses the variant. The animation reveals
            that known result. Its hash, sorted candidate list and index appear
            here after a real hatch.
          </p>
        )}
        <code>index = uint256(blockHash) % remaining.length</code>
      </section>
    </div>
  );
}
