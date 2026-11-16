"""Direct-mode tests for ClaimSettle.

    env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
        --with pytest --with genlayer-test pytest tests/direct -q

The evidence page and the model are mocked; the contract is not.
"""

import json

CONTRACT = "contracts/claim_settle.py"
PROMPT = r"adjudicating an insurance claim"
EVIDENCE = "https://holder.example.org/repair-invoice"

TERMS = (
    "1. This policy covers accidental damage to the insured laptop, including a "
    "cracked screen and liquid damage.\n"
    "2. The deductible is subtracted from every settled claim.\n"
    "3. Exclusions: loss, theft, cosmetic wear, and damage caused by a dropped "
    "device during a commercial delivery are not covered.\n"
    "4. The insurer may ask for a repair invoice or a photograph of the damage."
)


def who(addr):
    from genlayer import Address

    return str(Address(bytes(addr))).lower()


def deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def opened(contract, direct_vm, insurer, holder, policy_id="p-1", cap=1000, deductible=100, terms=TERMS):
    direct_vm.sender = insurer
    return contract.open_policy(policy_id, "Laptop accidental damage", who(holder), terms, cap, deductible)


def filed(contract, direct_vm, holder, claim_id="c-1", amount=500, description="the screen cracked when the lid was closed", policy_id="p-1"):
    direct_vm.sender = holder
    return contract.file_claim(policy_id, claim_id, amount, description, EVIDENCE)


def mock_round(direct_vm, payload):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"holder\.example\.org", {"status": 200, "body": "Repair invoice: screen replacement, 480 credits."})
    direct_vm.mock_llm(PROMPT, payload if isinstance(payload, str) else json.dumps(payload))


def decision(word="covered", clause="1. accidental damage", quote="screen replacement", reason="the terms cover accidental damage"):
    return {"decision": word, "clause": clause, "quote": quote, "reason": reason}


class TestPolicy:
    def test_the_terms_cap_and_deductible_are_written_once(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        out = opened(contract, direct_vm, direct_alice, direct_bob)

        assert out["policy_id"] == "p-1"
        assert out["insurer"] == who(direct_alice)
        assert out["holder"] == who(direct_bob)
        assert out["cap"] == 1000 and out["deductible"] == 100
        assert out["status"] == "active"

        policy = contract.get_policy("p-1")
        assert policy["terms"].startswith("1. This policy covers")
        assert policy["headroom"] == 1000 and policy["paid"] == 0
        assert contract.stats() == {"policies": 1, "active": 1, "claims": 0, "settled": 0, "paid": 0}

    def test_a_policy_needs_terms_an_holder_and_sane_numbers(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        holder = who(direct_alice)

        with direct_vm.expect_revert("terms are too short"):
            contract.open_policy("a", "T", holder, "short terms", 100, 0)
        with direct_vm.expect_revert("must be a 0x address"):
            contract.open_policy("b", "T", "nobody", TERMS, 100, 0)
        with direct_vm.expect_revert("cap must be a positive"):
            contract.open_policy("c", "T", holder, TERMS, 0, 0)
        with direct_vm.expect_revert("below the cap"):
            contract.open_policy("d", "T", holder, TERMS, 100, 100)
        with direct_vm.expect_revert("is taken"):
            opened(contract, direct_vm, direct_alice, direct_alice)
            opened(contract, direct_vm, direct_alice, direct_alice)


class TestClaim:
    def test_only_the_holder_files_and_the_claim_is_bounded(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        stranger = bytes([0x33] * 20)
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)

        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("only the holder"):
            contract.file_claim("p-1", "c-9", 100, "a description long enough to pass", EVIDENCE)

        with direct_vm.expect_revert("above the policy cap"):
            filed(contract, direct_vm, direct_bob, "c-2", amount=1500)
        with direct_vm.expect_revert("at least 20 characters"):
            filed(contract, direct_vm, direct_bob, "c-3", description="broken")
        with direct_vm.expect_revert("not an http"):
            direct_vm.sender = direct_bob
            contract.file_claim("p-1", "c-4", 100, "a description long enough to pass", "holder.example.org/x")

        direct_vm.sender = stranger
        with direct_vm.expect_revert("only the holder"):
            contract.file_claim("p-1", "c-5", 100, "a description long enough to pass", EVIDENCE)

    def test_a_claim_id_is_single_use_and_the_count_moves(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        out = filed(contract, direct_vm, direct_bob)

        assert out["status"] == "filed"
        assert out["amount"] == 500
        assert out["payout"] == 0
        assert contract.get_policy("p-1")["claims"] == 1

        with direct_vm.expect_revert("is taken on this policy"):
            filed(contract, direct_vm, direct_bob)


class TestAdjudication:
    def test_a_covered_claim_pays_the_amount_after_the_deductible(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        filed(contract, direct_vm, direct_bob, amount=500)

        mock_round(direct_vm, decision("covered"))
        direct_vm.sender = direct_alice
        out = contract.adjudicate("p-1", "c-1")

        assert out["decision"] == "covered"
        assert out["payout"] == 400
        assert out["clause"] == "1. accidental damage"
        assert out["quote"] == "screen replacement"
        assert out["status"] == "settled"
        assert contract.get_policy("p-1")["paid"] == 400
        assert contract.get_policy("p-1")["headroom"] == 600
        assert contract.stats()["paid"] == 400

    def test_a_partial_claim_pays_half_and_an_excluded_one_pays_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        filed(contract, direct_vm, direct_bob, "c-1", amount=500)
        filed(contract, direct_vm, direct_bob, "c-2", amount=300)
        filed(contract, direct_vm, direct_bob, "c-3", amount=200)

        mock_round(direct_vm, decision("partial"))
        direct_vm.sender = direct_alice
        partial = contract.adjudicate("p-1", "c-1")
        assert partial["payout"] == 200

        mock_round(direct_vm, decision("excluded", "3. exclusions", "cosmetic wear", "the damage is cosmetic"))
        direct_vm.sender = direct_alice
        excluded = contract.adjudicate("p-1", "c-2")
        assert excluded["payout"] == 0
        assert excluded["decision"] == "excluded"

        mock_round(direct_vm, decision("covered"))
        direct_vm.sender = direct_alice
        covered = contract.adjudicate("p-1", "c-3")
        assert covered["payout"] == 100
        assert contract.get_policy("p-1")["paid"] == 300

    def test_the_payout_never_exceeds_what_is_left_of_the_policy(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, cap=1000, deductible=100)
        filed(contract, direct_vm, direct_bob, "c-1", amount=900)
        filed(contract, direct_vm, direct_bob, "c-2", amount=900)

        mock_round(direct_vm, decision("covered"))
        direct_vm.sender = direct_alice
        first = contract.adjudicate("p-1", "c-1")
        assert first["payout"] == 800

        mock_round(direct_vm, decision("covered"))
        direct_vm.sender = direct_alice
        second = contract.adjudicate("p-1", "c-2")
        assert second["payout"] == 200
        policy = contract.get_policy("p-1")
        assert policy["paid"] == 1000 and policy["headroom"] == 0

    def test_a_deductible_above_the_claim_pays_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, deductible=400)
        filed(contract, direct_vm, direct_bob, amount=300)

        mock_round(direct_vm, decision("covered"))
        direct_vm.sender = direct_alice
        out = contract.adjudicate("p-1", "c-1")
        assert out["decision"] == "covered"
        assert out["payout"] == 0

    def test_only_the_insurer_adjudicates_and_only_once(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        filed(contract, direct_vm, direct_bob)

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the insurer"):
            contract.adjudicate("p-1", "c-1")

        mock_round(direct_vm, decision("covered"))
        direct_vm.sender = direct_alice
        contract.adjudicate("p-1", "c-1")
        with direct_vm.expect_revert("already settled"):
            contract.adjudicate("p-1", "c-1")

    def test_an_unknown_decision_stores_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        filed(contract, direct_vm, direct_bob)

        mock_round(direct_vm, {"decision": "probably", "clause": "", "quote": "", "reason": ""})
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("not covered, partial or excluded"):
            contract.adjudicate("p-1", "c-1")

        claim = contract.get_claim("p-1", "c-1")
        assert claim["status"] == "filed"
        assert claim["payout"] == 0
        assert contract.get_policy("p-1")["paid"] == 0

    def test_an_unreadable_evidence_page_stores_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        filed(contract, direct_vm, direct_bob)

        direct_vm.clear_mocks()
        direct_vm.mock_web(r"holder\.example\.org", {"status": 200, "body": "  "})
        direct_vm.mock_llm(PROMPT, json.dumps(decision("covered")))
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("no readable text"):
            contract.adjudicate("p-1", "c-1")
        assert contract.get_claim("p-1", "c-1")["status"] == "filed"


class TestLifecycle:
    def test_a_closed_policy_takes_no_claim_and_no_adjudication(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        filed(contract, direct_vm, direct_bob, "c-1")

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the insurer"):
            contract.close_policy("p-1")

        direct_vm.sender = direct_alice
        closed = contract.close_policy("p-1")
        assert closed["status"] == "closed"

        with direct_vm.expect_revert("is closed"):
            filed(contract, direct_vm, direct_bob, "c-2")
        with direct_vm.expect_revert("is closed"):
            direct_vm.sender = direct_alice
            contract.adjudicate("p-1", "c-1")

    def test_claims_are_listed_per_policy_and_policies_newest_first(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, "p-a")
        direct_vm.sender = direct_alice
        contract.open_policy("p-b", "Second", who(direct_bob), TERMS, 500, 0)

        filed(contract, direct_vm, direct_bob, "c-1", policy_id="p-a")
        filed(contract, direct_vm, direct_bob, "c-2", policy_id="p-a")

        rows = contract.claims_of("p-a")
        assert [r["id"] for r in rows] == ["c-1", "c-2"]
        assert contract.claims_of("p-b") == []
        listed = contract.list_policies(0, 10)
        assert [p["id"] for p in listed] == ["p-b", "p-a"]
