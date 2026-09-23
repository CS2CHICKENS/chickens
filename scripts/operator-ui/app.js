const $ = (id) => document.getElementById(id);
const session = document.querySelector('meta[name="operator-session"]').content;
let provider,
  selected,
  configuration,
  proposal,
  continuation,
  stopped = false,
  signing = false,
  pendingNext = false,
  verifiedPlan,
  verificationVersion = 0,
  wakeup;
const status = (message) => {
  $("status").textContent = message;
};
window.addEventListener("eip6963:announceProvider", (event) => {
  if (event.detail?.info?.rdns === "io.rabby") provider = event.detail.provider;
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-operator-session": session,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
const ether = (hex) => {
  const n = BigInt(hex);
  return (
    n / 10n ** 18n +
    (n % 10n ** 18n === 0n
      ? ""
      : "." + (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, ""))
  );
};
function clearPlan() {
  verifiedPlan = undefined;
  verificationVersion++;
  $("settle").disabled = true;
  $("budget").hidden = true;
  $("plan").textContent = "No round verified.";
  stopped = true;
  clearTimeout(wakeup);
}
function unlockPlanControls() {
  if (!proposal && !signing && !pendingNext) {
    $("round").disabled = false;
    $("prepare").disabled = false;
  }
}
function showBudget(plan) {
  const m = plan.manifest;
  if (m.creatorFeesWei === null)
    throw Error("Verified gross fees are required.");
  const gross = BigInt(m.creatorFeesWei),
    community = BigInt(m.potWei);
  if (gross < community || Number(m.round) !== Number(plan.round))
    throw Error("Round allocation mismatch.");
  const rows = [
    ["Verified creator fees", gross],
    ["Developer allocation", gross - community],
    ["Community allocation for this round", community],
    [
      "Holder batches scheduled (including carried rewards)",
      m.payouts.reduce((sum, row) => sum + BigInt(row.amountWei), 0n),
    ],
    [
      "Buyback and burn budget",
      Object.values(m.cook).reduce((sum, value) => sum + BigInt(value), 0n),
    ],
    [
      "Small rewards carried forward",
      m.carry.reduce((sum, row) => sum + BigInt(row.amountWei), 0n),
    ],
  ];
  $("budget-title").textContent = "ROUND " + m.round + " · VERIFIED BUDGET";
  $("budget-amounts").replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const name = document.createElement("dt"),
        amount = document.createElement("dd");
      name.textContent = label;
      amount.textContent = ether(value) + " ETH";
      return [name, amount];
    }),
  );
  $("budget").hidden = false;
}
async function refresh() {
  configuration = await api("status");
  $("destinations").textContent =
    "Network: Robinhood Chain (4663). Collection / Feed: " +
    configuration.wallets.feed +
    ". Developer: " +
    configuration.wallets.dev +
    ".";
  $("operations").textContent = JSON.stringify(
    configuration.operations,
    null,
    2,
  );
}
async function connect() {
  provider ??= window.ethereum?.isRabby ? window.ethereum : undefined;
  if (!provider)
    throw Error(
      "Open this page in Chrome or Edge with the Rabby extension enabled.",
    );
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  selected = accounts[0];
  $("account").textContent = selected ?? "No account selected";
}
async function next(mode) {
  if (pendingNext) throw Error("Wait for the current operation review.");
  if (stopped) {
    status("Stopped. Resume when ready.");
    return;
  }
  status("Checking confirmed operations, balances and transaction simulation…");
  if (mode === "settle" && !verifiedPlan)
    throw Error("Recompute and verify the selected round before settlement.");
  const version = verificationVersion;
  $("round").disabled = true;
  $("prepare").disabled = true;
  let result;
  pendingNext = true;
  try {
    result = await api("next", {
      mode,
      ...(mode === "settle"
        ? { round: verifiedPlan.round, proof: verifiedPlan.proof }
        : {}),
    });
  } catch (error) {
    pendingNext = false;
    unlockPlanControls();
    throw error;
  }
  pendingNext = false;
  proposal = result.proposal;
  if (mode === "settle" && version !== verificationVersion)
    throw Error(
      "The verified plan changed. Reconcile the pending operation before continuing.",
    );
  if (proposal?.waitUntil) {
    status(
      proposal.label +
        ": " +
        new Date(proposal.waitUntil * 1000).toLocaleTimeString() +
        ". Keep this page open.",
    );
    clearTimeout(wakeup);
    wakeup = setTimeout(
      () => next(mode).catch((error) => status(error.message)),
      Math.max(1000, Math.min(30000, proposal.waitUntil * 1000 - Date.now())),
    );
    proposal = undefined;
    return;
  }
  if (!proposal) {
    unlockPlanControls();
    status(
      mode === "deploy"
        ? "Both deployments are confirmed and verified. Publish the updated configuration before live settlement."
        : "Holder payments and every cook are confirmed and reported. Settlement complete.",
    );
    await refresh();
    return;
  }
  continuation = mode;
  $("round").disabled = true;
  $("transaction").textContent =
    proposal.label +
    "\nSigner: " +
    proposal.from +
    "\nDestination: " +
    (proposal.to ?? "New contract") +
    "\nETH value: " +
    ether(proposal.value) +
    "\nMaximum gas cost: " +
    ether(BigInt(proposal.gas) * BigInt(proposal.maxFeePerGas)) +
    " ETH\nOperation: " +
    proposal.id +
    "\nProof: " +
    proposal.proof;
  $("operation").value = proposal.id;
  $("review").hidden = false;
  status(
    "Review the operation. Rabby will show the transaction before signing.",
  );
}
async function approve() {
  if (!proposal) return;
  if (
    continuation === "settle" &&
    (!verifiedPlan ||
      proposal.proof !== verifiedPlan.proof ||
      !proposal.id.startsWith("round-" + verifiedPlan.round + "-"))
  )
    throw Error("The transaction does not belong to the verified round.");
  signing = true;
  try {
    await connect();
    if (selected.toLowerCase() !== proposal.from.toLowerCase())
      throw Error(
        "Select the required signing account in Rabby: " + proposal.from,
      );
    if (
      Number(await provider.request({ method: "eth_chainId" })) !==
      configuration.chainId
    )
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x1237" }],
      });
    if (
      Number(await provider.request({ method: "eth_chainId" })) !==
      configuration.chainId
    )
      throw Error("Select Robinhood Chain mainnet in Rabby");
    const {
      from,
      to,
      data,
      value,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId,
    } = proposal;
    let tx;
    try {
      tx = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            ...(to ? { to } : {}),
            data,
            value,
            gas,
            maxFeePerGas,
            maxPriorityFeePerGas,
            nonce,
            chainId,
          },
        ],
      });
    } catch (error) {
      if (error.code === 4001) {
        await api("cancel", { id: proposal.id });
        proposal = undefined;
        $("review").hidden = true;
      }
      throw error;
    }
    $("hash").value = tx;
    status(
      "Submitted. Waiting for confirmations and checking the exact transaction…",
    );
    await api("confirm", { id: proposal.id, tx });
    $("review").hidden = true;
    proposal = undefined;
    $("round").disabled = false;
    await refresh();
    await next(continuation);
  } finally {
    signing = false;
    unlockPlanControls();
  }
}
function action(id, callback) {
  $(id).addEventListener("click", async () => {
    if (signing) return;
    const button = $(id);
    button.disabled = true;
    try {
      await callback();
    } catch (error) {
      stopped = true;
      status(
        error.message ??
          "Operation stopped. Check Rabby and recover the saved transaction.",
      );
    } finally {
      button.disabled = false;
    }
  });
}
action("connect", connect);
action("deploy", async () => {
  stopped = false;
  await next("deploy");
});
action("prepare", async () => {
  clearPlan();
  const current = verificationVersion;
  status(
    "Reconstructing and verifying the round. No transaction will be sent.",
  );
  const plan = await api("prepare", { round: Number($("round").value) });
  if (current !== verificationVersion) {
    status("The selected round changed. Recompute and verify it again.");
    return;
  }
  showBudget(plan);
  verifiedPlan = plan;
  $("plan").textContent = JSON.stringify(plan, null, 2);
  $("settle").disabled = false;
  status("Independent verification passed. Review the plan before settlement.");
});
action("settle", async () => {
  stopped = false;
  await next("settle");
});
action("approve", approve);
action("reject", async () => {
  await api("cancel", { id: proposal.id });
  proposal = undefined;
  $("round").disabled = false;
  unlockPlanControls();
  $("review").hidden = true;
  stopped = true;
  status("Request cancelled before signing.");
});
action("recover", async () => {
  await api("confirm", { id: $("operation").value, tx: $("hash").value });
  await refresh();
  status("Transaction verified. Resume the operation.");
});
action("retry-failed", async () => {
  await api("retry-failed", { id: $("operation").value });
  await refresh();
  status(
    "Confirmed revert archived. Resume to simulate a fresh transaction. No successful payment can be retried here.",
  );
});
$("stop").addEventListener("click", () => {
  stopped = true;
  clearTimeout(wakeup);
  unlockPlanControls();
  status(
    "Stopping after the current transaction. Submitted transactions cannot be cancelled here.",
  );
});
$("round").addEventListener("input", clearPlan);
refresh()
  .then(() => status("Ready. Connect Rabby to the account shown above."))
  .catch((error) => status(error.message));
