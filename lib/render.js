import { fmt } from "./preflight.js";

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33);
const gasN = (g) => Number(g).toLocaleString("en-US");

export function renderPlan(p) {
  const out = ["", bold(`Batch plan · ${p.engine} · ${p.policy}`), dim(`wallet ${p.from} · Pacific block ${p.block.number}`), ""];
  for (const a of p.actions) out.push(`  ${a.ok ? green("✓") : red("✗")} #${String(a.index).padEnd(3)} ${fmt(BigInt(a.amount), a.decimals).padStart(14)} ${a.token.padEnd(6)} → ${a.to}${a.label ? dim(`  ${a.label}`) : ""}${a.ok ? "" : red(`\n         ${a.reason}`)}`);
  for (const w of p.warnings ?? []) out.push(yellow(`  ! ${w}`));
  for (const b of p.blockers ?? []) out.push(red(`  ✗ ${b}`));
  out.push("", `  ${p.outcome === "ready" ? green(bold("READY")) : p.outcome === "partial" ? yellow(bold("PARTIAL")) : red(bold(p.outcome.toUpperCase()))}  ${p.summary}`);
  if (p.gas) {
    const g = p.gas;
    const pct = g.saving.pct;
    out.push("", bold("  Gas") + dim(`  (base fee ${g.baseFeeGwei} gwei · PROS $${g.prosUsd.toFixed(4)})`));
    out.push(`    one by one   ${gasN(g.individual.gas).padStart(10)} gas  ${g.individual.pros.toFixed(6)} PROS  $${g.individual.usd.toFixed(5)}   ${dim(g.steps.individual)}`);
    out.push(`    as a batch   ${gasN(g.batch.gas).padStart(10)} gas  ${g.batch.pros.toFixed(6)} PROS  $${g.batch.usd.toFixed(5)}   ${dim(g.steps.batch)}`);
    out.push(`    ${pct >= 0 ? green(`saves ${gasN(g.saving.gas)} gas (${pct.toFixed(1)}%)`) : yellow(`costs ${gasN(-Number(g.saving.gas))} gas more (${(-pct).toFixed(1)}%) — the gain is in steps and failure isolation, not gas`)}`);
    if (g.approval) {
      const f = g.approval.firstBatchVsIndividualPct;
      const standing = g.approval.mode === "standing";
      out.push(dim(`    + ${standing ? "one-time " : ""}approval ${gasN(g.approval.gas)} gas (${g.approval.note})`));
      const vs = f >= 0 ? `${f.toFixed(1)}% less than one by one` : `${(-f).toFixed(1)}% more than one by one`;
      out.push(dim(standing ? `    this first time, with the approval: ${gasN(g.approval.firstBatchTotal)} gas — ${vs}; every later batch: the batch line above${g.approval.breakEvenBatch ? ` (ahead overall from batch ${g.approval.breakEvenBatch})` : ""}` : `    every batch, with its approval: ${gasN(g.approval.firstBatchTotal)} gas — ${vs}`));
    }
    if (g.other) out.push(dim(`    the ${g.other.engine} engine would use ${gasN(g.other.gas)} gas (${g.other.vsIndividualPct >= 0 ? `${g.other.vsIndividualPct.toFixed(1)}% less` : `${(-g.other.vsIndividualPct).toFixed(1)}% more`} than one by one)`));
    out.push(dim(`    batch gas measured with ${g.batch.measuredWith}`));
  }
  if (p.approvals?.length) {
    out.push("", bold("  First, once"));
    for (const a of p.approvals) out.push(`    ${a.label}`, dim(`    ${a.cast}`));
  }
  if (p.sign) out.push("", bold("  Then sign") + `  ${p.sign.kind === "permit2" ? "one EIP-712 message (Permit2 PermitBatchTransferFrom)" : `${p.sign.typedData.length} EIP-712 messages (USDC TransferWithAuthorization)`} — in the plan file, ready for eth_signTypedData_v4`);
  return out.join("\n");
}

export function renderAssembled(a) {
  const out = ["", bold("Batch transaction (unsigned)"), `  ${a.tx.label}`, dim(`  to ${a.tx.tx.to} · gas ${BigInt(a.tx.tx.gas)} · nonce ${BigInt(a.tx.tx.nonce)}`), "", bold("  Simulation, per action")];
  if (a.simulation.reason) out.push(red(`    the batch reverts: ${a.simulation.reason}`));
  for (const s of a.simulation.actions) out.push(`    ${s.success ? green("✓") : red("✗")} #${s.index}${s.success ? "" : red(` — ${s.reason}`)}`);
  if (a.simulation.overrides?.length) out.push(dim(`    as if: ${a.simulation.overrides.join("; ")}`));
  return out.join("\n");
}

export function renderVerify(v) {
  const out = ["", bold(`Receipt ${v.hash}`), dim(`  block ${v.block} · ${v.status} · gas used ${gasN(v.gasUsed)}`), ""];
  for (const a of v.actions) out.push(`  ${a.executed ? green("✓ happened") : red("✗ did not happen")}  #${a.index}${a.executed ? "" : dim(` — ${a.reason}`)}`);
  for (const u of v.unexpected) out.push(yellow(`  ! an unplanned transfer: ${u.value} of ${u.token} to ${u.to}`));
  out.push("", `  ${v.summary}`);
  return out.join("\n");
}
