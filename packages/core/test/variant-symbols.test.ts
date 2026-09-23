import test from "node:test";
import assert from "node:assert/strict";
import { config, matchesVariant } from "../src/index";
import { matchLaunch, type HatchRecord } from "../src/engine";

test("every variant has a unique short ticker distinct from base tokens", () => {
  const seen = new Set(config.tokens.map((token) => token.symbol));
  for (const family of config.families) {
    for (const id of family.variants) {
      const meta = config.variantMeta[id as keyof typeof config.variantMeta];
      assert.ok(meta, id);
      assert.match(meta.symbol, /^[CPS][A-Z]{2,9}$/);
      assert.equal(meta.symbol[0], family.id[0].toUpperCase());
      assert.equal(seen.has(meta.symbol), false, meta.symbol);
      seen.add(meta.symbol);
    }
  }
  assert.equal(
    seen.size,
    config.tokens.length + Object.keys(config.variantMeta).length,
  );
  assert.equal(
    config.variantMeta["silkie-brown-with-black-head"].symbol,
    "SBWBH",
  );
  assert.equal(config.variantMeta["silkie-black"].symbol, "SBLACK");
  assert.equal(config.variantMeta["catalana-black"].symbol, "CBLACK");
  assert.equal(
    config.variantMeta["polish-black-with-white-head"].symbol,
    "PBLACK",
  );
});

test("short tickers match only the full name of an available revealed variant", () => {
  for (const family of config.families) {
    for (const id of family.variants) {
      const { displayName, symbol } =
        config.variantMeta[id as keyof typeof config.variantMeta];
      const hatch: HatchRecord = {
        round: 1,
        family: family.id,
        hatchAt: 100,
        remaining: [id],
        block: 10,
        hash: "0x1234",
        variant: id,
        tokenAddress: null,
      };
      assert.equal(matchesVariant(id, displayName, symbol), true);
      assert.equal(matchLaunch(displayName, symbol, [hatch]), hatch);
      assert.equal(
        matchLaunch(displayName.toUpperCase(), symbol.toLowerCase(), [hatch]),
        hatch,
      );
      assert.equal(matchLaunch(displayName, id, [hatch]), null);
      assert.equal(matchLaunch(displayName, symbol + "X", [hatch]), null);
      assert.equal(matchLaunch("Different name", symbol, [hatch]), null);
      assert.equal(matchLaunch(displayName, symbol, []), null);
      assert.equal(matchLaunch(displayName, symbol, [hatch], [{ id }]), null);
      assert.equal(
        matchLaunch(displayName, symbol, [hatch, { ...hatch, round: 2 }]),
        null,
      );
    }
  }
});
