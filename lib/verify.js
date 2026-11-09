import { decodeEventLog, encodeFunctionData, getAddress } from "viem";
import { ABI } from "./contracts.js";
import { decodeAggregate3, decodeRevert } from "./engines.js";
import { errText } from "./preflight.js";

// After the batch is mined: what happened to EACH action, from the receipt itself.
// An action happened iff its Transfer (wallet → recipient, exact amount, right token) is in the receipt.
// For the ones that did not, the reason comes from re-running the same call at the parent block.

export async function verifyBatch(client, { hash, from, actions, engine }) {
  const rc = await client.getTransactionReceipt({ hash });
  const tx = await client.getTransaction({ hash });
  const wallet = getAddress(from);
  const transfers = [];
  for (const log of rc.logs) {
    try {
      const d = decodeEventLog({ abi: ABI.erc20, data: log.data, topics: log.topics });
      if (d.eventName === "Transfer") transfers.push({ token: getAddress(log.address), from: getAddress(d.args.from), to: getAddress(d.args.to), value: d.args.value });
    } catch {}
  }
  const used = new Set();
  const results = actions.map((a) => {
    const k = transfers.findIndex((t, i) => !used.has(i) && t.token === a.tokenAddress && t.from === wallet && t.to === a.to && t.value === BigInt(a.amount));
    if (k >= 0) used.add(k);
    return { index: a.index, executed: k >= 0 };
  });

  // reasons for what did not happen: replay the transaction's call at the parent block
  let reasons = {};
  if (results.some((r) => !r.executed)) {
    try {
      const out = await client.call({ account: tx.from, to: tx.to, data: tx.input, blockNumber: rc.blockNumber - 1n });
      if (engine === "eip3009") decodeAggregate3(out.data).forEach((p, i) => p.reason && (reasons[actions[i].index] = p.reason));
    } catch (e) {
      const data = e?.walk?.((x) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data;
      const why = data ? decodeRevert(data) : errText(e);
      for (const r of results) reasons[r.index] = `the whole transaction reverted: ${why}`;
    }
  }
  const extra = transfers.filter((t, i) => !used.has(i) && t.from === wallet);
  const executed = results.filter((r) => r.executed).length;
  return {
    hash,
    block: Number(rc.blockNumber),
    status: rc.status,
    gasUsed: rc.gasUsed.toString(),
    actions: results.map((r) => ({ ...r, reason: r.executed ? null : reasons[r.index] ?? "no matching Transfer in the receipt" })),
    unexpected: extra.map((t) => ({ to: t.to, value: t.value.toString(), token: t.token })),
    summary: rc.status !== "success" ? `Transaction reverted: none of the ${actions.length} transfers happened.` : executed === actions.length ? `All ${actions.length} transfers happened, as planned.` : `${executed} of ${actions.length} transfers happened; ${actions.length - executed} did not (each listed with its reason) — the others were not affected.`,
  };
}

/** What each action would do on its own right now (used to explain a reverted atomic batch). */
export async function whichWouldFail(client, blockNumber, from, actions) {
  return Promise.all(actions.map(async (a) => {
    try {
      await client.call({ account: from, to: a.tokenAddress, data: encodeFunctionData({ abi: ABI.erc20, functionName: "transfer", args: [a.to, BigInt(a.amount)] }), blockNumber });
      return { index: a.index, ok: true };
    } catch (e) {
      return { index: a.index, ok: false, reason: errText(e) };
    }
  }));
}
