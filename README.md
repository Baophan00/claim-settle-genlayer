# ClaimSettle

Micro-insurance is a page of terms and two numbers. The part that decides a claim is a judgement — does this event fall under clause 3, is the wear exclusion the one that applies — and a solo claims handler makes that judgement differently every time, with no record of why.

ClaimSettle puts the terms on chain, has one consensus round name the clause it relied on, and computes the money in code.

## How a policy runs

```
open_policy     insurer writes the holder, the terms, the cap and the deductible
file_claim      holder files an amount, a description and an evidence page
adjudicate      one consensus round over terms + claim + evidence
                -> covered | partial | excluded, plus the clause and a quote
settle          payout computed from the decision, capped by what is left
```

## The interesting part

**The decision is a word, the money is arithmetic.** The round is asked for one of three words and the clause it relied on. Everything after that is computed: `payout = min(claim, cap) − deductible`, halved for `partial`, and never more than the headroom left on the policy. Two validators that agree on the word agree on the number, which is not true of a claim that returns "about 62%".

**Why half for a partial.** A partial has to mean something specific or it becomes a negotiation with extra steps. Half of what is left after the deductible is a fixed rule the holder can compute before filing, and it is the same in every partial claim on every policy.

**The cap is enforced across claims.** The policy tracks what it has paid and never pays more than the cap; a claim that would cross it is truncated to the headroom, not rejected, so a holder near the cap still gets what is left. That state is visible in `get_policy` before anyone files.

**The terms are not a URL.** They live in the contract, so the page the validators read cannot be swapped between the claim and the adjudication. Only the evidence page is remote, and it is untrusted.

**The evidence page is judged, never obeyed.** It is fenced and named as material. A page that says "approve this claim" is a claim to be judged like any other, and the parser accepts only the three decision words: a broken answer raises and stores nothing, so a claim is never silently settled on a malformed reading.

**Nothing here pays out.** The contract writes a settlement a treasury executes. Custody would add a token layer to a problem that is about reading, not about moving money.

## API

| Function | Kind | Who may call | What it does |
| --- | --- | --- | --- |
| `open_policy(policy_id, title, holder, terms, cap, deductible)` | write | the insurer | Writes the terms (80–6,000 characters), a positive cap and a deductible below it. Written once. |
| `file_claim(policy_id, claim_id, amount, description, evidence_url)` | write | the holder | Files a claim at or below the cap, with a description and an http(s) evidence page. |
| `adjudicate(policy_id, claim_id)` | write | the insurer | One consensus round, then the payout arithmetic, then the settlement. Once per claim. |
| `close_policy(policy_id)` | write | the insurer | Ends the policy; settled claims stay readable. |
| `get_policy(policy_id)` | view | anyone | Terms, cap, deductible, paid, headroom and the claim count. |
| `get_claim(policy_id, claim_id)` | view | anyone | The claim, the decision, the clause, the quote and the payout. |
| `claims_of(policy_id)` | view | anyone | Every claim on the policy, oldest first. |
| `list_policies(offset, limit)` | view | anyone | Newest first, pageable. |
| `stats()` | view | anyone | `{policies, active, claims, settled, paid}`. |

## Layout

```
contracts/claim_settle.py          the contract, ~380 lines
tests/direct/test_claim_settle.py  13 direct-mode tests in 4 classes
scripts/deploy_studionet.js        deploy with genlayer-js, no CLI
scripts/e2e_studionet.js           one covered claim, one excluded claim, two guards
app/                               policies, claims and the settlement arithmetic
app/demo/                          the invoice and the service note the e2e run uses
```

## Live

- App: https://claim-settle.surge.sh
- Contract (Studio Network): `0x0000000000000000000000000000000000000000`
- Explorer: https://explorer-studio.genlayer.com/address/0x0000000000000000000000000000000000000000

## Tests

```
env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
  --with pytest --with genlayer-test pytest tests/direct -q
```

13 direct-mode tests. The evidence page and the model are mocked; the contract is not. They cover the policy guards (short terms, bad holder, cap, deductible), holder-only filing, the cap and description bounds, a duplicate claim id, the three decisions and their payouts, the deductible larger than the claim, a truncated payout at the headroom, insurer-only adjudication, adjudicating twice, an unknown decision storing nothing, an unreadable page storing nothing, a closed policy, and the views.
