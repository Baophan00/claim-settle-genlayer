import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0xd59334B0841F9048eF8489fEb42Aa8fB5402DD7E";
const KEY_SLOT = "claimsettle.key";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const short = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "");

let account = null;
let client = null;
let selected = null;

function toast(message, bad) {
  document.querySelectorAll(".toast").forEach((n) => n.remove());
  const node = el("div", `toast${bad ? " bad" : ""}`, message);
  document.body.append(node);
  setTimeout(() => node.remove(), bad ? 9000 : 4000);
}

function boot() {
  let raw = localStorage.getItem(KEY_SLOT);
  if (!raw) {
    localStorage.setItem(KEY_SLOT, JSON.stringify({ privateKey: generatePrivateKey() }));
    raw = localStorage.getItem(KEY_SLOT);
  }
  account = createAccount(JSON.parse(raw).privateKey);
  client = createClient({ chain: studionet, account });
  $("who").textContent = short(account.address);
  $("who").title = account.address;
}

const refreshBtn = document.getElementById("refresh");
if (refreshBtn) refreshBtn.addEventListener("click", () => render());

$("newkey").addEventListener("click", () => {
  localStorage.setItem(KEY_SLOT, JSON.stringify({ privateKey: generatePrivateKey() }));
  boot();
  render();
  toast("New key. Policies and claims from the old key stay on chain.");
});

const read = (fn, args) => client.readContract({ address: CONTRACT, functionName: fn, args });

async function readWithRetry(fn, args, tries = 2) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await read(fn, args);
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw last;
}

async function write(label, fn, args) {
  try {
    toast(`${label}…`);
    const hash = await client.writeContract({ address: CONTRACT, functionName: fn, args, value: 0n });
    const receipt = await client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 });
    const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
    if (String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR") {
      throw new Error("the contract refused this call");
    }
    toast(`${label}: settled`);
    await render();
    return true;
  } catch (error) {
    toast(`${label} failed: ${String((error && error.message) || error).slice(0, 220)}`, true);
    return false;
  }
}

// ------------------------------------------------------------------ rendering

async function renderMetrics() {
  try {
    const s = await readWithRetry("stats", []);
    $("metrics").replaceChildren(
      ...[
        ["Policies", s.policies],
        ["Active", s.active],
        ["Claims", s.claims],
        ["Paid out", s.paid],
      ].map(([label, value]) => {
        const box = el("div", "metric");
        box.append(el("b", "", String(value)));
        box.append(el("span", "", label));
        return box;
      })
    );
  } catch (error) {
    $("metrics").replaceChildren(el("div", "empty", "Reading the contract"));
  }
}

async function renderPolicies() {
  let rows = [];
  try {
    rows = await readWithRetry("list_policies", [0, 30]);
  } catch (error) {
    $("policies").replaceChildren(el("div", "empty", "The network did not answer."));
    return;
  }
  $("pcount").textContent = String(rows.length);
  if (!rows.length) {
    $("policies").replaceChildren(el("div", "empty", "No policy yet."));
    return;
  }
  $("policies").replaceChildren(
    ...rows.map((policy) => {
      const button = el("button", `pol${selected === policy.id ? " sel" : ""}`);
      const line1 = el("div", "line1");
      line1.append(el("strong", "", policy.title));
      line1.append(el("span", `tag ${policy.status}`, policy.status));
      button.append(line1);
      button.append(
        el("div", "sub2", `cap ${policy.cap} / deductible ${policy.deductible} / ${policy.claims} claims`)
      );
      const track = el("div", "mini-track");
      const fill = el("i");
      fill.style.width = `${policy.cap ? Math.min(100, Math.round((policy.paid / policy.cap) * 100)) : 0}%`;
      track.append(fill);
      button.append(track);
      button.addEventListener("click", () => {
        selected = policy.id;
        render();
      });
      return button;
    })
  );
  if (!selected) {
    selected = rows[0].id;
    await renderDetail();
  }
}

function decisionTag(claim) {
  if (claim.status !== "settled") return el("span", "tag filed", "awaiting decision");
  return el("span", `tag ${claim.decision}`, claim.decision);
}

function claimCard(claim, policy, isInsurer, isHolder) {
  const settled = claim.status === "settled";
  const box = el("div", `claim${settled ? ` settled ${claim.decision}` : ""}`);
  const top = el("div", "top");
  top.append(el("strong", "", claim.id));
  top.append(decisionTag(claim));
  if (claim.clause) {
    const line = el("div", "clause-line", `clause ${claim.clause.length > 96 ? `${claim.clause.slice(0, 96)}…` : claim.clause}`);
    line.title = claim.clause;
    box.append(line);
  }
  box.append(top);

  box.append(el("div", "desc", claim.description));

  if (settled) {
    const math = el("div", "math");
    const cells = [
      ["claimed", String(claim.amount), false],
      ["deductible", String(policy.deductible), false],
      ["decision", claim.decision, false],
      ["payout", String(claim.payout), true],
    ];
    for (const [label, value, isPayout] of cells) {
      const cell = el("div", isPayout ? "payout-cell" : "");
      const b = el("b", isPayout ? "payout" : "", value);
      cell.append(b, el("span", "", label));
      math.append(cell);
    }
    box.append(math);
    if (claim.quote) box.append(el("div", "quote", `“${claim.quote}”`));
    if (claim.reason) box.append(el("div", "note", claim.reason));
  } else if (isInsurer) {
    const actions = el("div", "actions");
    const run = el("button", "go", "Adjudicate");
    run.addEventListener("click", () => write(`Adjudicating ${claim.id}`, "adjudicate", [policy.id, claim.id]));
    actions.append(run);
    box.append(actions);
  }
  return box;
}

function claimForm(policy, isHolder) {
  const body = el("div", "fill-form");
  body.append(el("h3", "claims-title", "File a claim"));
  body.append(el("p", "note", `You are the holder. The evidence page is read against the terms and the decision names the clause.`));

  body.append(el("label", "", "Amount"));
  const amount = el("input");
  amount.id = "c-amount"; amount.type = "number"; amount.placeholder = "500";
  body.append(amount);

  body.append(el("label", "", "What happened"));
  const description = el("textarea");
  description.id = "c-desc";
  description.placeholder = "the screen cracked when the lid was closed with a cable on the keyboard";
  body.append(description);

  body.append(el("label", "", "Evidence page (invoice, service note, photographs in text)"));
  const evidence = el("input");
  evidence.id = "c-evidence"; evidence.placeholder = "https://example.org/invoice.html";
  body.append(evidence);

  const actions = el("div", "actions");
  const submit = el("button", "go", "File claim");
  submit.addEventListener("click", async () => {
    const value = Number($("c-amount").value);
    const text = $("c-desc").value.trim();
    const url = $("c-evidence").value.trim();
    if (!value || text.length < 20 || !url) {
      toast("an amount, a description of 20+ characters and an evidence URL are required", true);
      return;
    }
    const id = `c-${Date.now().toString(36)}`;
    await write("Filing the claim", "file_claim", [policy.id, id, value, text, url]);
  });
  actions.append(submit);
  body.append(actions);
  return body;
}

async function renderDetail() {
  if (!selected) return;
  let policy;
  let claims;
  try {
    policy = await readWithRetry("get_policy", [selected]);
    claims = await readWithRetry("claims_of", [selected]);
  } catch (error) {
    $("detail").replaceChildren(el("div", "empty", "The network did not answer. It retries on its own in a moment."));
    return;
  }
  const me = account.address.toLowerCase();
  const isInsurer = policy.insurer === me;
  const isHolder = policy.holder === me;

  const head = el("div");
  const top = el("div", "policy-top");
  const title = el("div", "policy-head");
  title.append(el("h3", "", policy.title));
  title.append(el("span", `tag ${policy.status}`, policy.status));
  top.append(title);
  top.append(
    el("div", "muted", `insurer ${short(policy.insurer)}${isInsurer ? " (you)" : ""} / holder ${short(policy.holder)}${isHolder ? " (you)" : ""}`)
  );

  const facts = el("div", "facts");
  for (const [value, label] of [
    [String(policy.cap), "cap"],
    [String(policy.paid), "paid"],
    [String(policy.headroom), "headroom"],
  ]) {
    const cell = el("div", "fact");
    cell.append(el("b", "", value), el("span", "", label));
    facts.append(cell);
  }
  top.append(facts);

  const cover = el("div", "cover");
  const track = el("div", "track");
  const fill = el("i");
  fill.style.width = `${policy.cap ? Math.min(100, Math.round((policy.paid / policy.cap) * 100)) : 0}%`;
  track.append(fill);
  cover.append(track);
  const legend = el("div", "legend2");
  legend.append(el("span", "", `${policy.paid} paid`), el("span", "", `${policy.headroom} left`));
  cover.append(legend);
  top.append(cover);
  head.append(top);

  const terms = el("div", "terms");
  terms.textContent = policy.terms;
  head.append(terms);

  const claimsWrap = el("div", "claims");
  const claimsTitle = el("div", "claims-title");
  claimsTitle.append(el("span", "", "Claim history"));
  const tally = el("span", "", `${claims.filter((c) => c.status === "settled").length} settled of ${claims.length}`);
  claimsTitle.append(tally);
  claimsWrap.append(claimsTitle);

  if (!claims.length) claimsWrap.append(el("div", "empty", "No claim filed on this policy yet."));
  for (const claim of claims) claimsWrap.append(claimCard(claim, policy, isInsurer, isHolder));

  if (isInsurer && policy.status === "active") {
    const actions = el("div", "actions");
    const close = el("button", "ghost", "Close policy");
    close.addEventListener("click", () => write("Closing the policy", "close_policy", [policy.id]));
    actions.append(close);
    claimsWrap.append(actions);
  }

  claimsWrap.append(
    el("p", "note", "Payout is min(claim, cap) minus the deductible, halved for a partial, and never more than the headroom left on the policy.")
  );
  head.append(claimsWrap);

  if (isHolder && policy.status === "active") head.append(claimForm(policy, isHolder));

  $("detail").replaceChildren(head);
}

async function render() {
  await renderMetrics();
  await renderPolicies();
  if (selected) await renderDetail();
}

$("toggle-form").addEventListener("click", () => {
  const form = $("pform");
  form.style.display = form.style.display === "none" ? "block" : "none";
});

$("do-policy").addEventListener("click", async () => {
  const title = $("p-title").value.trim();
  const holder = $("p-holder").value.trim();
  const terms = $("p-terms").value.trim();
  const cap = Number($("p-cap").value);
  const deductible = Number($("p-ded").value);
  if (!title || !/^0x[0-9a-fA-F]{40}$/.test(holder) || terms.length < 80) {
    toast("a title, a 0x holder and 80+ characters of terms are required", true);
    return;
  }
  const id = `pol-${Date.now().toString(36)}`;
  const ok = await write("Publishing the policy", "open_policy", [id, title, holder, terms, cap, deductible]);
  if (ok) {
    selected = id;
    $("pform").style.display = "none";
    await render();
  }
});

boot();
render();
