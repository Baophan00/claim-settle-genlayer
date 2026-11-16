#!/usr/bin/env node
/**
 * Two claims on one policy, on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * The insurer writes the terms, the cap and the deductible. The holder files a
 * repair invoice, which is read against those terms and settled. A second claim
 * points at a service note that describes wear, and is excluded by the terms.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const KEY_PATH = path.join(__dirname, ".settle-keys.json");
const keys = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parties = {
  insurer: createClient({ chain: studionet, account: createAccount(keys.insurer) }),
  holder: createClient({ chain: studionet, account: createAccount(keys.holder) }),
  stranger: createClient({ chain: studionet, account: createAccount(keys.stranger) }),
};
const watcher = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

async function retrying(label, fn) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error && error.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(message)) {
        throw error;
      }
      last = error;
      console.log(`  ${label}: rpc hiccup, retry ${attempt + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

function failed(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function call(role, fn, args) {
  console.log(`\n[${role}] ${fn}(${args.map((a) => JSON.stringify(a).slice(0, 52)).join(", ")})`);
  const hash = await retrying("send", () =>
    parties[role].writeContract({ address: ADDRESS, functionName: fn, args, value: 0n })
  );
  console.log(`  tx ${hash}`);
  const receipt = await retrying("receipt", () =>
    parties[role].waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 })
  );
  const refused = failed(receipt);
  console.log(`  ${receipt.status_name || receipt.status}  (${refused ? "refused by the contract" : "executed"})`);
  return { hash, refused };
}

async function must(role, fn, args) {
  const out = await call(role, fn, args);
  if (out.refused) throw new Error(`${fn} was refused`);
  return out.hash;
}

const view = (fn, args) =>
  retrying("read", () => watcher.readContract({ address: ADDRESS, functionName: fn, args }));

const TERMS = [
  "1. Covered: accidental damage to the insured laptop, including a cracked screen, a broken hinge caused by impact, and liquid damage.",
  "2. Every settled claim is paid minus the deductible of this policy.",
  "3. Excluded: loss, theft, cosmetic wear, paint wear, and maintenance that the manual schedules (including hinge tightening after 24 months of use).",
  "4. The insurer may require a repair invoice, a service note, or photographs before adjudicating.",
  "5. The total paid across all claims never exceeds the cap of this policy.",
].join("\n");

(async () => {
  const policyId = process.argv[3] || `policy-${Date.now().toString(36)}`;
  const holder = createAccount(keys.holder).address;
  console.log("contract", ADDRESS);
  console.log("policy  ", policyId);
  console.log("holder  ", holder);

  await must("insurer", "open_policy", [policyId, "Laptop accidental damage", holder, TERMS, 1000, 100]);
  const policy = await view("get_policy", [policyId]);
  console.log(`\n  active | cap ${policy.cap} | deductible ${policy.deductible} | headroom ${policy.headroom}`);

  console.log("\n[guard] a stranger cannot file a claim");
  const stranger = await call("stranger", "file_claim", [
    policyId, "c-x", 400, "a laptop screen cracked at the office last week", "https://claim-settle.surge.sh/demo/invoice.html",
  ]);
  if (!stranger.refused) throw new Error("a stranger filed a claim");

  console.log("\n[holder] file claim c-1 with the repair invoice");
  await must("holder", "file_claim", [
    policyId, "c-1", 500, "the screen cracked when the lid was closed with a cable on the keyboard",
    "https://claim-settle.surge.sh/demo/invoice.html",
  ]);

  console.log("\n[insurer] adjudicate c-1 against the terms");
  let t0 = Date.now();
  await must("insurer", "adjudicate", [policyId, "c-1"]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  let claim = await view("get_claim", [policyId, "c-1"]);
  console.log(`  ${claim.decision} | clause ${claim.clause || "-"} | payout ${claim.payout}`);
  if (claim.decision !== "covered" || claim.payout !== 400) {
    throw new Error(`c-1 settled as ${claim.decision} for ${claim.payout}`);
  }

  console.log("\n[guard] the same claim cannot be adjudicated twice");
  const twice = await call("insurer", "adjudicate", [policyId, "c-1"]);
  if (!twice.refused) throw new Error("a settled claim was adjudicated again");

  console.log("\n[holder] file claim c-2 with the service note about wear");
  await must("holder", "file_claim", [
    policyId, "c-2", 300, "a wobbly lid and scuffed corners two weeks after the screen was replaced",
    "https://claim-settle.surge.sh/demo/wear.html",
  ]);

  console.log("\n[insurer] adjudicate c-2 against the terms");
  t0 = Date.now();
  await must("insurer", "adjudicate", [policyId, "c-2"]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  claim = await view("get_claim", [policyId, "c-2"]);
  console.log(`  ${claim.decision} | clause ${claim.clause || "-"} | payout ${claim.payout}`);
  if (claim.decision !== "excluded" || claim.payout !== 0) {
    throw new Error(`c-2 settled as ${claim.decision} for ${claim.payout}`);
  }

  const after = await view("get_policy", [policyId]);
  console.log(`\n  paid ${after.paid} of ${after.cap} | headroom ${after.headroom} | claims ${after.claims}`);

  console.log("\nclaims");
  for (const row of await view("claims_of", [policyId])) {
    console.log(`  ${row.id}: ${row.decision} | ${row.amount} − ${after.deductible} → ${row.payout} | ${row.clause}`);
    if (row.quote) console.log(`    “${row.quote.slice(0, 90)}”`);
  }

  console.log("\nstats");
  console.log(JSON.stringify(await view("stats", []), null, 2));

  console.log(
    "\nRESULT: terms on chain, one claim covered after the deductible, one excluded by the wear clause, a repeated adjudication refused, and the policy cap respected"
  );
})().catch((error) => {
  console.error("\nFAILED:", error.message);
  if (error.cause) console.error(String(error.cause).slice(0, 900));
  process.exit(1);
});
