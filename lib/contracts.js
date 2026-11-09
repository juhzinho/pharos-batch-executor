import { encodeAbiParameters, getAddress, keccak256, parseAbi } from "viem";

// Pharos Pacific Mainnet. All checked on chain:
// - USDC / WPROS: the official token registry. USDC is Circle FiatToken v2.2: EIP-3009, EIP-712 domain
//   {name "USDC", version "2", chainId 1672} (its DOMAIN_SEPARATOR() matches).
// - Permit2 at its canonical address: DOMAIN_SEPARATOR() matches {name "Permit2", chainId 1672}.
// - Multicall3 at its canonical address (aggregate3 with per-call allowFailure).
// - PROS/USD: Chainlink self-managed feed (docs.pharos.xyz → Oracles), 18 decimals.

export const CHAIN_ID = 1672;
export const PACIFIC_RPC = "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const TOKENS = {
  USDC: { symbol: "USDC", address: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"), decimals: 6, eip3009: true },
  WPROS: { symbol: "WPROS", address: getAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0"), decimals: 18, eip3009: false },
};
export const tokenByAddress = (a) => Object.values(TOKENS).find((t) => t.address === getAddress(a));

export const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
export const PROS_USD = getAddress("0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466");

export const USDC_DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKENS.USDC.address };
export const PERMIT2_DOMAIN = { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 };

export const TYPES = {
  permit2Batch: {
    PermitBatchTransferFrom: [{ name: "permitted", type: "TokenPermissions[]" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
    TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  },
  eip3009: {
    TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }],
  },
};

export const ABI = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 value) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]),
  usdc: parseAbi([
    "function isBlacklisted(address account) view returns (bool)",
    "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
    "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  ]),
  permit2: parseAbi([
    "struct TokenPermissions { address token; uint256 amount; }",
    "struct PermitBatchTransferFrom { TokenPermissions[] permitted; uint256 nonce; uint256 deadline; }",
    "struct SignatureTransferDetails { address to; uint256 requestedAmount; }",
    "function permitTransferFrom(PermitBatchTransferFrom permit, SignatureTransferDetails[] transferDetails, address owner, bytes signature)",
    "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
  ]),
  multicall3: parseAbi([
    "struct Call3 { address target; bool allowFailure; bytes callData; }",
    "struct Result { bool success; bytes returnData; }",
    "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  ]),
  feed: parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]),
};

// Storage layout used ONLY for eth_call state overrides in simulations (nothing is ever written on chain):
// USDC (FiatToken): balances slot 9, allowed slot 10 — checked against balanceOf for a real holder.
// WPROS (WETH9): balanceOf slot 3, allowance slot 4.
export const SLOTS = { [TOKENS.USDC.address]: { balance: 9n, allowance: 10n }, [TOKENS.WPROS.address]: { balance: 3n, allowance: 4n } };
export const mapSlot = (key, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
export const allowanceSlot = (owner, spender, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, mapSlot(owner, slot)]));
