/**
 * @untch/consumer-providers — the outward-facing half of the Consumer Pack.
 *
 * Everything that touches a merchant lives here: the hardened HTTP client, the runtime validators,
 * the x402 / MPP / SIWX protocol clients, the typed adapter contract, and the concrete integrations.
 * The domain core (@untch/consumer-core) depends on none of it, which is what keeps the state
 * machine, the ledger and the treasury testable with no network and no secrets.
 */

export {
  type ProviderFetchOptions,
  type ProviderResponse,
  SsrfRefusedError,
  assertFetchable,
  isBlockedAddress,
  parseJsonBody,
  providerFetch,
  redactAddress,
  redactEmail,
  redactForLog,
} from "./http";

export {
  ValidationError,
  arr,
  atomic,
  bool,
  decimalString,
  dig,
  get,
  httpsUrl,
  int,
  obj,
  oneOf,
  optHttpsUrl,
  optStr,
  str,
  validated,
} from "./schema";

export {
  type ChallengeKind,
  type SelectedPayment,
  type SelectionContext,
  type SiwxRequest,
  type X402Challenge,
  type X402PaymentOption,
  classifyChallenge,
  decodeChallengeHeader,
  eip3009DomainFor,
  parseChallenge,
  selectPayment,
} from "./x402/challenge";

export { X402EvmExactClient, buildAuthorizationTypedData, type EvmExactClientDeps } from "./x402/evm-exact";
export {
  X402SolanaExactClient,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_GENESIS,
  ACCEPTED_TOKEN_PROGRAMS,
  associatedTokenAccountFor,
  SOLANA_MIN_LAMPORTS,
  SOLANA_RECIPIENT_ALLOWLIST,
  confirmSolanaSettlement,
  isSolanaMainnet,
  observeSolanaSettlementAccount,
  selectSolanaOption,
  type ObservedSolanaAccount,
  type SolanaExactClientDeps,
} from "./x402/solana-exact";
export {
  buildV2SvmCredential,
  decodeSvmTransfer,
  type DecodedTransfer,
  type V2Credential,
  type V2CredentialInput,
} from "./x402/v2-svm-client";

export {
  type MppChallenge,
  type MppChargeRequest,
  MppTempoClient,
  isMppOnly,
  parseWwwAuthenticate,
} from "./mpp/challenge";

export { SiwxSigner, renderSiwxMessage, type SiwxCredential, type SiwxSignerDeps } from "./siwx/sign";

export {
  BaseAdapter,
  type AdapterContext,
  type ConsumerProviderAdapter,
  type PaidRequestInput,
  type PaidRequestResult,
  type ProviderCapabilityDescriptor,
  type ProviderHealth,
} from "./adapter";

export {
  StableDomainsAdapter,
  STABLEDOMAINS_BASE_PAYTO,
  STABLEDOMAINS_BASE_URL,
  STABLEDOMAINS_DISCOVERY_COSTS,
  SUPPORTED_TLDS,
  normalizeDomain,
} from "./adapters/stabledomains";
export {
  StableEmailAdapter,
  STABLEEMAIL_BASE_PAYTO,
  STABLEEMAIL_BASE_URL,
  parseNotifyMessage,
  type NotifyMessage,
} from "./adapters/stableemail";
export {
  PurchAdapter,
  PURCH_BASE_URL,
  PURCH_SOLANA_PAYTO,
  parseShippingAddress,
  type ShippingAddress,
} from "./adapters/purch";
export { StableTravelAdapter, STABLETRAVEL_BASE_URL } from "./adapters/stabletravel";
export { MERCH_PRODUCTS, StableMerchAdapter, STABLEMERCH_BASE_URL } from "./adapters/stablemerch";

export { PROVIDER_SEEDS, seededCapabilities, type ProviderSeed } from "./seed";
export {
  assertSeedMatchesAdapters,
  buildAdapterRegistry,
  type AdapterRegistry,
} from "./registry";
