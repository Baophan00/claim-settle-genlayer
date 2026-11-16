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

$("newkey").addEventListener("click", () => {
  localStorage.setItem(KEY_SLOT, JSON.stringify({ privateKey: generatePrivateKey() }));
  boot();
  render();
  toast("New key. Policies and claims from the old key stay on chain.");
});

const read = (fn, args) => client.readContract({ address: CONTRACT, functionName: fn, args });

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
    const s = await read("stats", []);
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
    $("metrics").replaceChildren(el("div", "empty", `cannot read the contract: ${String(error.message).slice(0, 120)}`));
  }
}

async function renderPolicies() {
  let rows = [];
  try {
    rows = await read("list_policies", [0, 30]);
  } catch (error) {
    $("policies").replaceChildren(el("div", "body empty", String(error.message).slice(0, 140)));
    return;
  }
  $("pcount").textContent = String(rows.length);
  if (!rows.length) {
    $("policies").replaceChildren(el("div", "body empty", "No policy yet."));
    return;
  }
  $("policies").replaceChildren(
    ...rows.map((policy) => {
      const button = el("button", `pol${selected === policy.id ? " sel" : ""}`);
      const top = el("div");
      top.style.display = "flex";
      top.style.gap = "8px";
      top.style.alignItems = "center";
      top.append(el("strong", "", policy.title));
      top.append(el("span", `tag ${policy.status}`, policy.status));
      button.append(top);
      button.append(
        el("div", "sub2", `cap ${policy.cap} / deductible ${policy.deductible} / ${policy.claims} claims / headroom ${policy.headroom}`)
      );
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
  const box = el("div", "claim");
  const top = el("div", "top");
  top.append(el("strong", "", `claim ${claim.id}`));
  top.append(decisionTag(claim));
  if (claim.clause) top.append(el("span", "muted", `clause: ${claim.clause}`));
  box.append(top);

  box.append(el("div", "desc", claim.description));

  if (claim.status === "settled") {
    const math = el("div", "math");
    const cells = [
      ["claimed", String(claim.amount)],
      ["deductible", String(policy.deductible)],
      ["decision", claim.decision],
      ["payout", String(claim.payout)],
    ];
    for (const [label, value] of cells) {
      const cell = el("div");
      const b = el("b", label === "payout" ? "payout" : "", value);
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
  const body = el("div", "body");
  body.append(el("h3", "", "File a claim"));
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
    policy = await read("get_policy", [selected]);
    claims = await read("claims_of", [selected]);
  } catch (error) {
    $("detail").replaceChildren(el("div", "body empty", String(error.message).slice(0, 160)));
    return;
  }
  const me = account.address.toLowerCase();
  const isInsurer = policy.insurer === me;
  const isHolder = policy.holder === me;

  const head = el("div", "body");
  const title = el("div", "policy-head");
  const line = el("div");
  line.style.display = "flex";
  line.style.gap = "8px";
  line.style.alignItems = "center";
  line.append(el("h3", "", policy.title));
  line.append(el("span", `tag ${policy.status}`, policy.status));
  title.append(line);
  title.append(el("div", "muted", `insurer ${short(policy.insurer)}${isInsurer ? " (you)" : ""} / holder ${short(policy.holder)}${isHolder ? " (you)" : ""}`));
  title.append(el("div", "muted", `cap ${policy.cap} / deductible ${policy.deductible} / paid ${policy.paid} / headroom ${policy.headroom}`));
  head.append(title);

  head.append(el("div", "terms", policy.terms));

  if (isInsurer && policy.status === "active") {
    const actions = el("div", "actions");
    const close = el("button", "", "Close policy");
    close.addEventListener("click", () => write("Closing the policy", "close_policy", [policy.id]));
    actions.append(close);
    head.append(actions);
  }

  const list = el("div");
  list.style.padding = "0 18px";
  if (!claims.length) list.append(el("div", "body empty", "No claim filed on this policy yet."));
  for (const claim of claims) list.append(claimCard(claim, policy, isInsurer, isHolder));
  head.append(list);

  if (isHolder && policy.status === "active") head.append(claimForm(policy, isHolder));

  head.append(
    el("p", "note", "Payout = min(claim, cap) − deductible, halved for a partial, and never more than the headroom left on the policy.")
  );

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
setInterval(render, 20000);
