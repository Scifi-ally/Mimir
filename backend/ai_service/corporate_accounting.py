"""Conservative corporate entitlement ledger for raw-price research.

Receipt coverage and announcement chronology are checked elsewhere. An
entitlement is not spendable cash or permission to sell undelivered shares.
Unknown actions are explicit review failures, never zero-cost omissions.
"""
from __future__ import annotations

from copy import deepcopy
from fractions import Fraction
import math
import re


class CorporateEvidenceError(ValueError):
    """Simulation cannot establish corporate entitlements or tradable shares."""


def decode_action(purpose: str) -> dict:
    text = re.sub(r"\s+", " ", purpose.upper()).strip()
    stated_split = re.fullmatch(r"FACE VALUE SPLIT \(SUB-DIVISION\) - FROM R(?:S|E)\s*(\d+(?:\.\d+)?)/- PER SHARE TO R(?:S|E)\s*(\d+(?:\.\d+)?)/- PER SHARE", text)
    if stated_split:
        old, new = map(Fraction, stated_split.groups())
        if old > 0 and new > 0:
            return {"kind": "split", "share_multiplier": str(old / new)}
    # Combined/conditional actions require separate verified terms.
    if any(word in text for word in ("RIGHT", "RGHT", "DEMERG", "MERGER", "REDUCTION", "CONSOLID", "%", "SPECIAL DISTRIBUTION")):
        return {"kind": "unsupported", "review_required": True}
    bonus = re.fullmatch(r"BONUS(?: ISSUE)?\s+(\d+)\s*:\s*(\d+)", text)
    if bonus:
        new, old = map(int, bonus.groups())
        if old > 0 and new > 0:
            return {"kind": "bonus", "share_multiplier": str(Fraction(old + new, old))}
    split = re.fullmatch(r"(?:FVSPLT FRM|FACE VALUE SPLIT FROM|SPLIT FROM)\s+RS\.?\s*(\d+(?:\.\d+)?)\s+TO\s+RS\.?\s*(\d+(?:\.\d+)?)", text)
    if split:
        old, new = map(Fraction, split.groups())
        if old > 0 and new > 0:
            return {"kind": "split", "share_multiplier": str(old / new)}
    components = [part.strip() for part in text.split("/")]
    if len(components) != len(set(components)):
        return {"kind": "unsupported", "review_required": True}
    cash = Fraction(0)
    for component in components:
        notice = re.sub(r"[\s-]", "", component)
        if notice in ("AGM", "EGM", "ANNUALGENERALMEETING", "EXTRAORDINARYGENERALMEETING"):
            continue
        dividend = re.fullmatch(r"(?:(?:INTERIM|FINAL|SPECIAL)\s+)?DIV(?:IDEND)?\s*-?\s*R(?:S|E)\.?\s*(\d+(?:\.\d+)?)\s+PER\s+SH(?:ARE)?", component)
        if not dividend or Fraction(dividend.group(1)) <= 0:
            return {"kind": "unsupported", "review_required": True}
        cash += Fraction(dividend.group(1))
    if cash:
        try:
            amount = float(cash)
        except OverflowError:
            return {"kind": "unsupported", "review_required": True}
        return {"kind": "dividend", "cash_per_share": amount} if math.isfinite(amount) else {"kind": "unsupported", "review_required": True}
    if components:
        return {"kind": "notice"}
    return {"kind": "unsupported", "review_required": True}


def empty_ledger() -> dict:
    return {"applied_events": [], "entitlements": [], "review_failures": [], "settled_cash": 0.0}


def apply_event(ledger: dict, position: dict, event: dict, session: str) -> tuple[dict, dict]:
    """Apply at ex-date before fills, using shares carried from the prior day.

    Caller supplies independently validated event dates/identity. Settlement
    proofs are deliberately separate: a public ex-date is insufficient.
    """
    state, holding = deepcopy(ledger), deepcopy(position)
    event_id = event["event_id"]
    if event_id in state["applied_events"]:
        return state, holding
    if event["ex_date"] != session or holding["entry_date"] >= session or event["isin"] != holding["isin"]:
        return state, holding
    quantity = holding["quantity"]
    if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0:
        raise ValueError("Integer prior-session holding required")
    terms = decode_action(event["purpose"])
    state["applied_events"].append(event_id)
    if terms["kind"] == "notice":
        return state, holding
    if terms["kind"] == "unsupported":
        state["review_failures"].append({"event_id": event_id, "reason": "unsupported_corporate_terms"})
        return state, holding
    if terms["kind"] == "dividend":
        amount = quantity * terms["cash_per_share"]
        state["entitlements"].append({"event_id": event_id, "kind": "cash", "amount": amount,
                                      "ex_date": session, "settled": False})
        # Economic cash claim is recorded without funding subsequent orders.
        holding["dividend_entitlement"] = holding.get("dividend_entitlement", 0.0) + amount
        holding["stop"] = max(0.0, holding["stop"] - terms["cash_per_share"])
        return state, holding
    multiplier = Fraction(terms["share_multiplier"])
    entitled = quantity * multiplier
    holding["entry"] /= float(multiplier)
    holding["stop"] /= float(multiplier)
    holding["reference"] /= float(multiplier)
    state["entitlements"].append({"event_id": event_id, "kind": "shares", "total_shares_after": str(entitled),
                                  "original_shares": quantity, "ex_date": session, "settled": False})
    # Without an independently proven credit date, no extra sellable shares.
    holding["corporate_delivery_pending"] = True
    state["review_failures"].append({"event_id": event_id, "reason": "share_delivery_or_fractional_entitlement_unverified"})
    return state, holding


def settle_cash(ledger: dict, event_id: str, amount: float, proof: dict, session: str) -> dict:
    """Credit only a verified broker/bank receipt; never infer payment from ex-date."""
    if not math.isfinite(amount) or amount <= 0 or proof.get("verified") is not True or proof.get("source") not in ("broker_cash_statement", "bank_statement") or not proof.get("receipt_sha256") or proof.get("date", "9999") > session:
        raise ValueError("Independently verified cash-credit proof required")
    state = deepcopy(ledger)
    matches = [e for e in state["entitlements"] if e["event_id"] == event_id and e["kind"] == "cash"]
    if len(matches) != 1 or amount > matches[0]["amount"] or proof["date"] < matches[0]["ex_date"]:
        raise ValueError("Cash credit does not match entitlement")
    item = matches[0]
    if item["settled"]:
        if item["received_cash"] != amount or item["proof"] != proof:
            raise ValueError("Conflicting duplicate cash settlement")
        return state
    item.update(settled=True, received_cash=amount, proof=deepcopy(proof))
    state["settled_cash"] += amount
    return state


def settle_shares(ledger: dict, position: dict, event_id: str, total_shares: int, proof: dict, session: str) -> tuple[dict, dict]:
    """Release only proven whole-share balances; fractional proceeds need a receipt."""
    if isinstance(total_shares, bool) or not isinstance(total_shares, int) or total_shares <= 0 or proof.get("verified") is not True or proof.get("source") != "broker_demat_statement" or not proof.get("receipt_sha256") or proof.get("date", "9999") > session:
        raise ValueError("Verified demat balance required")
    state, holding = deepcopy(ledger), deepcopy(position)
    matches = [e for e in state["entitlements"] if e["event_id"] == event_id and e["kind"] == "shares"]
    if len(matches) != 1 or Fraction(matches[0]["total_shares_after"]) != total_shares or proof["date"] < matches[0]["ex_date"]:
        raise ValueError("Whole-share credit does not match entitlement")
    item = matches[0]
    if item["settled"]:
        if item["proof"] != proof or holding["quantity"] != total_shares:
            raise ValueError("Conflicting duplicate share settlement")
        return state, holding
    item.update(settled=True, proof=deepcopy(proof))
    holding["quantity"] = total_shares
    holding["corporate_delivery_pending"] = False
    state["review_failures"] = [r for r in state["review_failures"] if not (r["event_id"] == event_id and r["reason"] == "share_delivery_or_fractional_entitlement_unverified")]
    return state, holding
