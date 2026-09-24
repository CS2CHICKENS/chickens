"use client";
import { LinkArrow } from "./link-arrow";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAddress } from "viem";
import { config } from "../../../packages/core/src/index";
import { useGame } from "./data";
import { Art, Buy, Copy, explorer } from "./game";
import styles from "./token-verifier.module.css";

const families = new Map(
  config.families.flatMap((family) =>
    family.variants.map((variant) => [variant, family.id] as const),
  ),
);
const normalized = (address: string) => address.toLowerCase();

export function TokenVerifier() {
  const { state, connection, delayed } = useGame();
  const [input, setInput] = useState("");
  const [checked, setChecked] = useState<string | null>(null);
  const result = useRef<HTMLElement>(null);
  const valid = checked !== null && isAddress(checked, { strict: false });
  const base = valid
    ? config.tokens.find(
        (token) => normalized(token.address) === normalized(checked),
      )
    : undefined;
  const complete = config.tokens.every((base) =>
    state.tokens.some(
      (token) =>
        token.id === base.id &&
        normalized(token.address) === normalized(base.address),
    ),
  );
  const consistent =
    state.tokens.every(
      (token) =>
        config.tokens.some(
          (base) =>
            token.id === base.id &&
            normalized(token.address) === normalized(base.address),
        ) ||
        (families.get(token.id) === token.family && families.has(token.id)),
    ) &&
    new Set(state.tokens.map((token) => token.id)).size ===
      state.tokens.length &&
    new Set(state.tokens.map((token) => normalized(token.address))).size ===
      state.tokens.length;
  const registryReady =
    connection === "ready" &&
    !delayed &&
    state.mode !== "demo" &&
    state.headBlock > 0 &&
    complete &&
    consistent;
  const variant =
    valid && registryReady
      ? state.tokens.find(
          (token) =>
            families.has(token.id) &&
            normalized(token.address) === normalized(checked),
        )
      : undefined;
  const match = base ?? variant;
  const variantMeta = variant
    ? config.variantMeta[variant.id as keyof typeof config.variantMeta]
    : undefined;
  const name = base?.symbol ?? variantMeta?.displayName ?? "";
  const family = config.families.find(
    (family) =>
      family.id ===
      (variant?.family ?? (base && "family" in base ? base.family : null)),
  );

  useEffect(() => {
    if (checked !== null) result.current?.focus();
  }, [checked]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecked(input.trim());
  }
  return (
    <div className={"page " + styles.page}>
      <header className={styles.intro}>
        <span className="eyebrow">KNOW WHAT YOU ARE BUYING</span>
        <h1>CHECK A TOKEN</h1>
        <p>
          Paste a contract address to check whether it belongs to CS2 Chickens.
        </p>
        <span className={styles.network}>
          ROBINHOOD CHAIN <span aria-hidden="true">/</span> NETWORK 4663
        </span>
      </header>

      <form onSubmit={submit} className={styles.form}>
        <label htmlFor="token-address">CONTRACT ADDRESS</label>
        <div className={styles.inputRow}>
          <input
            id="token-address"
            value={input}
            placeholder="0x…"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="token-address-help"
            aria-invalid={checked !== null && !valid}
            onChange={(event) => {
              setInput(event.target.value);
              setChecked(null);
            }}
          />
          <button className="button primary" type="submit">
            CHECK ADDRESS
          </button>
        </div>
        <p id="token-address-help">
          Use the full address, not the token name or ticker. No wallet
          connection needed.
        </p>
      </form>

      {checked !== null && (
        <section
          ref={result}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={
            styles.result + " " + (match ? styles.matched : styles.notice)
          }
          aria-label="Address check result"
        >
          {match ? (
            <>
              <div className={styles.artwork}>
                <Art id={match.id} eager />
              </div>
              <div className={styles.resultBody}>
                <span className="eyebrow">ADDRESS MATCH</span>
                <h2>{name}</h2>
                <p className={styles.resultLead}>
                  This is a listed CS2 Chickens{" "}
                  {base ? "base token" : "launched variant"} on Robinhood Chain.
                </p>
                <div className={styles.tags}>
                  <span>{base ? "BASE TOKEN" : "LAUNCHED VARIANT"}</span>
                  {family && <span>{family.name.toUpperCase()} FAMILY</span>}
                </div>
                <code className={styles.address}>{match.address}</code>
                <Copy value={match.address} />
                <div className={styles.actions}>
                  <Link className="button primary" href={"/tokens/" + match.id}>
                    TOKEN DETAILS <LinkArrow />
                  </Link>
                  <Buy address={match.address} />
                  <a
                    className="button"
                    href={explorer + "/token/" + match.address}
                  >
                    EXPLORER <LinkArrow />
                  </a>
                </div>
                <p className={styles.proof}>
                  {base
                    ? "Matched against the base addresses published with this site. This check also works when live updates are unavailable."
                    : "Matched against the published launch registry through block " +
                      state.headBlock.toLocaleString("en-US") +
                      "."}
                </p>
              </div>
            </>
          ) : (
            <div className={styles.resultBody}>
              <span className="eyebrow">
                {!valid
                  ? "ADDRESS NEEDED"
                  : registryReady
                    ? "NO MATCH AT THIS BLOCK"
                    : "CHECK INCOMPLETE"}
              </span>
              <h2>
                {!valid
                  ? "Enter a complete contract address"
                  : registryReady
                    ? "Not in the published registry"
                    : "Live registry unavailable"}
              </h2>
              <p className={styles.resultLead}>
                {!valid
                  ? "An address starts with 0x followed by 40 hexadecimal characters. Copy the contract address from the token page and try again."
                  : registryReady
                    ? "This address does not match a listed CS2 Chickens token through block " +
                      state.headBlock.toLocaleString("en-US") +
                      ". A newer launch may appear after the next update."
                    : "This is not one of the five base addresses. The latest variant registry is unavailable, delayed or incomplete, so we cannot finish this check yet."}
              </p>
              {valid && (
                <>
                  <code className={styles.address}>{checked}</code>
                  <p>
                    No match is not a judgment about another token. Names,
                    tickers and artwork alone do not establish a project's
                    identity.
                  </p>
                  <div className={styles.actions}>
                    <Link className="button" href="/inventory">
                      BROWSE OFFICIAL INVENTORY <LinkArrow />
                    </Link>
                    <a
                      className="text-link"
                      href={explorer + "/address/" + checked}
                    >
                      VIEW ADDRESS ON EXPLORER <LinkArrow />
                    </a>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      <section className={styles.guide} aria-label="How to check a token">
        <div>
          <span className="eyebrow">SAME NAME DOES NOT MEAN SAME TOKEN</span>
          <h2>THE ADDRESS IS THE IDENTITY.</h2>
          <p>
            Copy the full contract address from the market page you plan to use.
            Compare it here, and make sure the network is Robinhood Chain. A
            matching logo or ticker is not enough.
          </p>
          <p>
            This checks the project's published addresses. It does not assess
            price, returns or contract safety.
          </p>
        </div>
        <div className={styles.examples}>
          <span className="eyebrow">TRY A PUBLISHED BASE TOKEN</span>
          <div>
            {config.tokens.map((token) => (
              <button
                key={token.id}
                type="button"
                onClick={() => {
                  setInput(token.address);
                  setChecked(token.address);
                }}
                aria-label={"Check " + token.symbol + " example"}
              >
                {token.symbol}{" "}
                <span aria-hidden="true">
                  <LinkArrow />
                </span>
              </button>
            ))}
          </div>
          <p>
            New variants appear here after their on-chain launches are
            registered.
          </p>
        </div>
      </section>
    </div>
  );
}
