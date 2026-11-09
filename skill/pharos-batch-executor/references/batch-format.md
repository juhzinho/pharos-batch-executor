# Batch format

## JSON

```json
{
  "from": "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d",
  "engine": "permit2",
  "policy": "skip-failed",
  "approve": "standing",
  "actions": [
    { "to": "0x1111111111111111111111111111111111111111", "amount": "1200", "label": "payroll — Ana" },
    { "to": "0x2222222222222222222222222222222222222222", "amount": "850.5" },
    { "to": "0x5555555555555555555555555555555555555555", "amount": "12.5", "token": "WPROS" }
  ]
}
```

| field | values | default |
|---|---|---|
| `from` | the paying wallet (an EOA; a contract or EIP-7702 wallet is blocked) | required (or `--from`) |
| `engine` | `permit2`, `eip3009` (USDC only) | `permit2` |
| `policy` | `skip-failed` — failing actions are left out, the rest go; `all-or-nothing` — one failing action refuses the batch | `skip-failed` |
| `approve` | `standing` — approve Permit2 once per token; `exact` — only what this batch moves (permit2 only) | `standing` |
| `actions[].to` | recipient address (not zero, not the wallet itself) | required |
| `actions[].amount` | a decimal **string**, within the token's decimals (USDC 6, WPROS 18) | required |
| `actions[].token` | `USDC`, `WPROS` | `USDC` |
| `actions[].label` | free text, up to 80 characters, shown in every report | — |

3 to 100 actions. Identical actions (same recipient, token and amount) are allowed but flagged as a possible double
payment.

## CSV

A header row is required; `token` and `label` columns are optional; lines starting with `#` are ignored.

```csv
to,amount,token,label
0x6666666666666666666666666666666666666666,1000,USDC,invoice 1042
0x7777777777777777777777777777777777777777,1500,USDC,invoice 1043
0x9999999999999999999999999999999999999999,5,WPROS,gas top-up
```

`from`, `engine`, `policy` and `approve` come from the flags (`--from 0x… --engine eip3009 …`).

## What a plan contains (`.batch/plan.json`)

- `actions[]` — each with `ok` and, if not, `reason` (e.g. `insufficient USDC: 137,839.927209 left after the actions before it, 999,999 needed`)
- `outcome` — `ready`, `partial` (some left out), `refused` (policy or nothing left), `blocked` (the wallet itself)
- `sign` — `{ kind, typedData }`: one object (permit2) or one per transfer (eip3009), ready for `eth_signTypedData_v4`
- `approvals[]` — unsigned approve transactions with `cast send` equivalents (permit2, first time per token)
- `gas` — `individual` (each transfer estimated on its own, from the wallet), `batch` (the one transaction), `saving`,
  `approval` (with `firstBatchTotal` and `breakEvenBatch`), `other` (the other engine), `steps`
- `warnings` — e.g. a duplicate action, or not enough PROS for gas
