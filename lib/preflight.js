import { encodeFunctionData, formatUnits, pad, toHex } from "viem";
import { ABI, PERMIT2, SLOTS, TOKENS, allowanceSlot, mapSlot } from "./contracts.js";

// Before anything is signed: read the wallet at the pinned block and simulate every action in order, each with the
// balance left after the ones before it (an eth_call of the token's transfer from the wallet). The result says, per
// action, whether it can go through and why not — so a failing action is known before the batch exists.

export const errText = (e) => {
  let c = e;
  while (c?.cause && c.cause !== c) c = c.cause;
  const m = String(c?.details || c?.shortMessage || c?.message || e);
  return m.replace(/^execution reverted:?\s*/i, "").split("\n")[0].slice(0, 140);
};

export function balanceOverride(owner, balances = {}, allowances = {}) {
  const byToken = new Map();
  const add = (token, slot, value) => {
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push({ slot, value: pad(toHex(value)) });
  };
  for (const [token, v] of Object.entries(balances)) add(token, mapSlot(owner, SLOTS[token].balance), v);
  for (const [token, v] of Object.entries(allowances)) add(token, allowanceSlot(owner, PERMIT2, SLOTS[token].allowance), v);
  return [...byToken].map(([address, stateDiff]) => ({ address, stateDiff }));
}

export async function walletState(client, blockNumber, batch) {
  const at = { blockNumber };
  const tokens = [...new Set(batch.actions.map((a) => a.tokenAddress))];
  const [code, pros, balances, allowances, fromBlacklisted] = await Promise.all([
    client.getCode({ address: batch.from, ...at }),
    client.getBalance({ address: batch.from, ...at }),
    Promise.all(tokens.map((t) => client.readContract({ address: t, abi: ABI.erc20, functionName: "balanceOf", args: [batch.from], ...at }))),
    Promise.all(tokens.map((t) => client.readContract({ address: t, abi: ABI.erc20, functionName: "allowance", args: [batch.from, PERMIT2], ...at }))),
    client.readContract({ address: TOKENS.USDC.address, abi: ABI.usdc, functionName: "isBlacklisted", args: [batch.from], ...at }),
  ]);
  return {
    address: batch.from,
    pros,
    hasCode: !!code && code !== "0x",
    eip7702: !!code && code.startsWith("0xef0100"),
    balance: Object.fromEntries(tokens.map((t, i) => [t, balances[i]])),
    permit2Allowance: Object.fromEntries(tokens.map((t, i) => [t, allowances[i]])),
    blacklisted: fromBlacklisted,
  };
}

/** A revert from the contract (a reason for that action) — as opposed to the RPC failing (which must not pass as one). */
export const isRevert = (e) => {
  const test = (x) => /revert/i.test(`${x?.name ?? ""} ${x?.details ?? ""} ${x?.shortMessage ?? ""} ${x?.message ?? ""}`);
  return typeof e?.walk === "function" ? !!e.walk(test) : test(e);
};

export async function preflight(client, blockNumber, batch, wallet) {
  const at = { blockNumber };
  const usdcRecipients = batch.actions.filter((a) => a.token === "USDC").map((a) => a.to);
  const blacklist = new Map(await Promise.all([...new Set(usdcRecipients)].map(async (to) => [to, await client.readContract({ address: TOKENS.USDC.address, abi: ABI.usdc, functionName: "isBlacklisted", args: [to], ...at })])));
  // The token itself must accept each transfer, from this wallet, with exactly the balance left before it. The
  // simulations run in parallel: the balance walk is done in order first, assuming every simulation passes; a
  // transfer that passes with some balance also passes with more. If one is refused its amount stays in the wallet,
  // so the walk is redone and only the actions that now fit for the first time are simulated (a few rounds at most).
  const simulated = new Map(); // action index → null (accepted) | reason
  const simulate = (a, left) =>
    client.call({ account: batch.from, to: a.tokenAddress, data: encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [a.to, a.amount] }), ...at, stateOverride: balanceOverride(batch.from, { [a.tokenAddress]: left }) }).then(
      () => null,
      (e) => {
        if (!isRevert(e)) throw e;
        return `${a.token} refuses the transfer: ${errText(e)}`;
      },
    );
  for (;;) {
    const remaining = { ...wallet.balance };
    const out = [];
    const todo = [];
    for (const a of batch.actions) {
      const left = remaining[a.tokenAddress];
      let reason = null;
      if (wallet.blacklisted && a.token === "USDC") reason = "the paying wallet is blacklisted by USDC";
      else if (blacklist.get(a.to)) reason = "the recipient is blacklisted by USDC";
      else if (a.amount > left) reason = `insufficient ${a.token}: ${fmt(left, a.decimals)} left after the actions before it, ${fmt(a.amount, a.decimals)} needed`;
      else if (simulated.has(a.index)) reason = simulated.get(a.index);
      else todo.push([a, left]);
      if (!reason) remaining[a.tokenAddress] = left - a.amount;
      out.push({ ...a, ok: !reason, reason });
    }
    if (todo.length) {
      const results = await Promise.all(todo.map(([a, left]) => simulate(a, left)));
      todo.forEach(([a], i) => simulated.set(a.index, results[i]));
      if (results.some((r) => r !== null)) continue; // a refusal frees its amount: walk again
    }
    const blockers = [];
    if (wallet.hasCode) blockers.push(wallet.eip7702 ? "the wallet has an EIP-7702 delegation: USDC and Permit2 then verify signatures through the delegated contract (EIP-1271), not the key — a plain signature will be rejected" : "the paying address is a contract: signatures are verified through EIP-1271");
    return { actions: out, blockers, remaining };
  }
}

/** Exact (no floats): 137839927209, 6 → "137,839.927209"; at most 6 decimals, truncated; dust shows as "<0.000001". */
export function fmt(raw, decimals) {
  const v = BigInt(raw);
  const [i, f = ""] = formatUnits(v, decimals).split(".");
  const frac = f.slice(0, 6).replace(/0+$/, "");
  if (v > 0n && i === "0" && !frac) return "<0.000001";
  return BigInt(i).toLocaleString("en-US") + (frac ? `.${frac}` : "");
}
