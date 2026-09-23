import { test } from "node:test";
import assert from "node:assert/strict";
import { publicOrigin, dataHeaders, stateIssues } from "../verify-release";
import { config } from "../../packages/core/src/index";
import { emptyState } from "../../packages/core/src/state";

test("release origins reject credentials, query parameters and local asset paths", () => {
  assert.equal(
    publicOrigin("https://assets.example.test/"),
    "https://assets.example.test",
  );
  for (const value of [
    "http://example.test",
    "https://name:password@example.test",
    "https://example.test/?key=value",
    "/img",
  ])
    assert.throws(() => publicOrigin(value));
  assert.throws(() => publicOrigin("https://example.test/site", true));
});

test("release data requires usable CORS and short browser and CDN cache lifetimes", () => {
  const headers = new Headers({
    "content-type": "application/json",
    "access-control-allow-origin": "https://example.test",
    "cache-control": "public, max-age=4, s-maxage=4",
  });
  assert.deepEqual(dataHeaders(headers, "https://example.test"), {
    json: true,
    cors: true,
    cache: true,
  });
  assert.equal(
    dataHeaders(headers, "https://different.example.test").cors,
    false,
  );
  headers.set("cache-control", "public, max-age=4, s-maxage=3600");
  assert.equal(dataHeaders(headers, "https://example.test").cache, false);
  headers.set("cache-control", "public, max-age=3600, s-maxage=4");
  assert.equal(dataHeaders(headers, "https://example.test").cache, false);
});

test("a fresh monitoring release requires every real token and known supply", () => {
  const state = structuredClone(emptyState);
  state.mode = "monitoring";
  state.updatedAt = 1000;
  state.headBlock = 100;
  state.stale = false;
  state.kitchen.supplyLeftWei = "1000000000000000000000000000";
  state.tokens = config.tokens.map((token) => ({
    id: token.id,
    address: token.address,
    priceEth: 0,
    priceUsd: null,
    marketCapUsd: null,
    volumeRoundEth: 0,
    holders: 0,
    graduationProgress: 0,
  }));
  assert.deepEqual(stateIssues(state, "monitoring", 1001), []);
  assert.ok(stateIssues(state, "live", 1001).length > 0);
  assert.ok(
    stateIssues(state, "monitoring", 1181).some((issue) =>
      issue.includes("stale"),
    ),
  );
  state.tokens[0].address = "0x" + "1".repeat(40);
  assert.ok(
    stateIssues(state, "monitoring", 1001).some((issue) =>
      issue.includes("mismatched"),
    ),
  );
  state.tokens = [];
  state.kitchen.supplyLeftWei = null;
  assert.ok(
    stateIssues(state, "monitoring", 1001).some((issue) =>
      issue.includes("supply"),
    ),
  );
});

test("intentional prelaunch does not pass as a live release", () => {
  assert.deepEqual(stateIssues(emptyState, "prelaunch"), []);
  assert.ok(stateIssues(emptyState, "live").length > 0);
});

test("live release waits for payout aggregates and complete collection receipt coverage", () => {
  const state = structuredClone(emptyState);
  state.mode = "live";
  state.headBlock = 100;
  state.feed.accountingReady = false;
  const issues = stateIssues(state, "live");
  assert.ok(issues.some((issue) => issue.includes("Payout accounting")));
  assert.ok(
    issues.some((issue) => issue.includes("Collection receipt coverage")),
  );
  state.feed.accountingReady = true;
  state.feed.collection = {
    status: "ambiguous",
    fromBlock: 1,
    throughBlock: 100,
    lowerBoundWei: "1",
    upperBoundWei: "2",
    escrowClaimedWei: "2",
    otherCreditsWei: "1",
  };
  const ready = stateIssues(state, "live");
  assert.ok(
    !ready.some(
      (issue) =>
        issue.includes("Payout accounting") ||
        issue.includes("Collection receipt coverage"),
    ),
  );
});
