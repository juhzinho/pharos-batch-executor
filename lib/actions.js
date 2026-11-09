import { getAddress, isAddress, zeroAddress } from "viem";
import { TOKENS } from "./contracts.js";

// A batch: a wallet, a list of independent token transfers, an engine and a failure policy.
//   { "from": "0x…", "engine": "permit2" | "eip3009", "policy": "skip-failed" | "all-or-nothing",
//     "approve": "standing" | "exact"   (permit2 only: how the one-time ERC-20 allowance to Permit2 is sized)
//     "actions": [ { "to": "0x…", "amount": "250.5", "token": "USDC", "label": "invoice 1042" }, … ] }
// or a CSV with a header: to,amount[,token][,label]. Amounts are decimal strings (never floats).

export const ENGINES = ["permit2", "eip3009"];
export const POLICIES = ["skip-failed", "all-or-nothing"];
export const APPROVALS = ["standing", "exact"];
export const MAX_ACTIONS = 100;

export function parseAmount(text, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text ?? "").trim());
  if (!m) throw new Error(`“${text}” is not an amount (use digits and an optional decimal point)`);
  if ((m[2] ?? "").length > decimals) throw new Error(`“${text}” has more than ${decimals} decimals`);
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
  if (v <= 0n) throw new Error(`amount must be positive (got “${text}”)`);
  return v;
}

/** CSV → actions. Header required; quoted fields not needed for addresses/amounts/plain labels. */
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) throw new Error("CSV needs a header (to,amount[,token][,label]) and at least one row");
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  for (const k of ["to", "amount"]) if (!head.includes(k)) throw new Error(`CSV header must contain “${k}”`);
  return lines.slice(1).map((l) => {
    const cells = l.split(",").map((c) => c.trim());
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/** Validates a batch and returns it normalised (checksummed addresses, bigint amounts, numbered actions). */
export function validateBatch(raw, { from: fromOverride } = {}) {
  const b = typeof raw === "string" ? { actions: parseCsv(raw) } : raw;
  const fromText = fromOverride ?? b.from;
  if (!fromText || !isAddress(String(fromText), { strict: false })) throw new Error("from: the paying wallet address is required (0x…)");
  const from = getAddress(String(fromText).toLowerCase());
  const engine = b.engine ?? "permit2";
  if (!ENGINES.includes(engine)) throw new Error(`engine must be one of ${ENGINES.join(", ")}`);
  const policy = b.policy ?? "skip-failed";
  if (!POLICIES.includes(policy)) throw new Error(`policy must be one of ${POLICIES.join(", ")}`);
  const approve = b.approve ?? "standing";
  if (!APPROVALS.includes(approve)) throw new Error(`approve must be one of ${APPROVALS.join(", ")}`);
  if (!Array.isArray(b.actions) || b.actions.length < 3) throw new Error("actions: at least 3 independent actions");
  if (b.actions.length > MAX_ACTIONS) throw new Error(`actions: at most ${MAX_ACTIONS} per batch`);
  const actions = b.actions.map((a, i) => {
    const where = `actions[${i}]`;
    const symbol = String(a.token || "USDC").toUpperCase();
    const token = TOKENS[symbol];
    if (!token) throw new Error(`${where}.token “${a.token}” is not supported (${Object.keys(TOKENS).join(", ")})`);
    if (engine === "eip3009" && !token.eip3009) throw new Error(`${where}: ${symbol} has no EIP-3009 — use engine "permit2"`);
    if (!isAddress(String(a.to ?? ""), { strict: false })) throw new Error(`${where}.to “${a.to}” is not an address`);
    const to = getAddress(String(a.to).toLowerCase());
    if (to === zeroAddress) throw new Error(`${where}.to is the zero address`);
    if (to === from) throw new Error(`${where}.to is the paying wallet itself`);
    let amount;
    try {
      amount = parseAmount(a.amount, token.decimals);
    } catch (e) {
      throw new Error(`${where}.amount: ${e.message}`);
    }
    return { index: i + 1, to, token: token.symbol, tokenAddress: token.address, decimals: token.decimals, amount, label: a.label ? String(a.label).slice(0, 80) : null };
  });
  // independent actions: an exact duplicate is almost always a mistake (paying the same invoice twice)
  const seen = new Map();
  const warnings = [];
  for (const a of actions) {
    const k = `${a.to}:${a.token}:${a.amount}`;
    if (seen.has(k)) warnings.push(`actions ${seen.get(k)} and ${a.index} are identical (same recipient, token and amount) — check it is not a double payment`);
    else seen.set(k, a.index);
  }
  return { from, engine, policy, approve, actions, warnings };
}
