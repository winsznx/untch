/**
 * @untch/consumer-core — the Consumer Pack domain core.
 *
 * What lives here (and nowhere else):
 *   • Money  — integer atomic units bound to a (chain, token, decimals). No float ever holds money.
 *   • Assets — the confirmed/unconfirmed chain + token registry, and the settlement allowlist.
 *   • State  — the 22-state Consumer Intent machine and the single `assertTransition` authority.
 *   • Ledger — append-only double entry; every group is single-asset and sums to zero.
 *   • Events — the outbox contract, SSE framing, webhook signing.
 *   • Store  — the storage interface, implemented in memory and against Postgres.
 *
 * What does NOT live here: HTTP, provider adapters, signing keys. Those are @untch/consumer-providers
 * and the ASP wiring, so the domain stays testable with no network and no secrets.
 */

export {
  canReleasePreSign,
  describeProofGate,
  isReusable,
  solanaProofScopeHash,
  type SolanaProofGateRecord,
  type SolanaProofGateState,
  type SolanaProofProgress,
  type SolanaProofScope,
} from "./solana-proof-claim";
export {
  SolanaProofGate,
  loadSolanaProofGate,
  type SolanaProofGateConfig,
  type ProofAuthorisationInput,
} from "./solana-proof-gate";
export {
  type AssetRef,
  type AssetEntry,
  type CaipChainId,
  type ChainFamily,
  type ChainProfile,
  type ConfirmedAsset,
  type UnconfirmedAsset,
  ASSETS,
  BASE_MAINNET,
  CHAIN_PROFILES,
  SOLANA_MAINNET,
  TEMPO_MAINNET,
  X_LAYER_MAINNET,
  asset,
  assetKey,
  chainProfile,
  confirmedAssetsFor,
  describeAsset,
  isAllowedSettlementAsset,
  isConfirmedAsset,
  lookupAsset,
  maybeAsset,
  settlementAllowlist,
} from "./assets";

export {
  type Money,
  type MoneyJson,
  type RoundingMode,
  MoneyAssetMismatchError,
  MoneyParseError,
  NegativeMoneyError,
  addMoney,
  applyBasisPoints,
  cmpMoney,
  displayMoney,
  eqMoney,
  formatMoney,
  gtMoney,
  gteMoney,
  isNegative,
  isZero,
  ltMoney,
  lteMoney,
  maxMoney,
  minMoney,
  money,
  moneyFromJson,
  moneyToJson,
  parseMoney,
  sameAsset,
  subMoney,
  subMoneyChecked,
  sumMoney,
  zeroMoney,
} from "./money";

export {
  type ConsumerIntentState,
  CONSUMER_INTENT_STATES,
  EXPIRABLE_STATES,
  EXPIRY_TARGET,
  InvalidStateTransitionError,
  POST_PAYMENT_STATES,
  IdempotencyConflictError,
  StaleIntentStateError,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
  isConsumerIntentState,
  isPostPayment,
  isTerminal,
  successorsOf,
} from "./state";

export {
  type ErrorEnvelope,
  type NormalizedProviderError,
  type ProviderErrorCode,
  ProviderError,
  isProviderError,
  normalizedError,
  sanitizeProviderText,
  toErrorEnvelope,
  unknownProviderError,
} from "./errors";

export {
  type ConsumerIntentId,
  deriveIdempotencyKey,
  hashQuote,
  newCapabilityId,
  newCorrelationId,
  newDiscoveryId,
  newIntentId,
  newQuoteId,
  normalizeIdempotencyKey,
  providerIdempotencyKey,
  safeEqual,
  sha256Hex,
  stableStringify,
  isIntentId,
} from "./ids";

export {
  type ConsumerEvent,
  type ConsumerEventName,
  type OutboxRecord,
  type ParsedWebhookSignature,
  CONSUMER_EVENT_NAMES,
  EVENT_FOR_STATE,
  TERMINAL_EVENTS,
  WEBHOOK_BACKOFF_MS,
  eventForState,
  isConsumerEventName,
  parseLastEventId,
  parseWebhookSignatureHeader,
  sseHeartbeat,
  toSseFrame,
  webhookRetryDelayMs,
  webhookSignatureHeader,
  webhookSigningPayload,
} from "./events";

export {
  type LedgerAccount,
  type LedgerAccountKind,
  type LedgerEntry,
  type LedgerGroup,
  type LedgerGroupKind,
  type RailReconciliation,
  LedgerAssetMixError,
  LedgerImbalanceError,
  accountIdFor,
  assertBookBalanced,
  assertGroupBalanced,
  assertIntentSettled,
  clearingAccount,
  fundingGroup,
  projectBalances,
  reconcileRail,
  recognitionGroup,
  refundGroup,
  settlementGroup,
  suspenseGroup,
  treasuryAccount,
  treasuryTransferGroups,
  userObligationAccount,
} from "./ledger";

export {
  type CanonicalQuote,
  type ConsumerActionType,
  type ConsumerApproval,
  type ConsumerCategory,
  type ConsumerIntent,
  type ConsumerIntentPatch,
  type ConsumerQuote,
  type ConsumerReceiptView,
  type DeliveryEvidence,
  type DiscoveryInput,
  type DiscoveryOption,
  type DiscoveryResult,
  type ExecuteInput,
  type FundingReceipt,
  type FundingRequest,
  type ProviderCancellation,
  type ProviderExecution,
  type ProviderExecutionRecord,
  type ProviderQuote,
  type ProviderReference,
  type ProviderStatus,
  type QuoteInput,
  VALUE_MOVING_ACTIONS,
  CONSUMER_ACTION_TYPES,
  isConsumerActionType,
  policyCategoryFor,
} from "./types";

export {
  type CapabilityAccessBlocker,
  type CapabilityRecord,
  type ConsumerStore,
  type CreateIntentInput,
  type PauseFlag,
  type PauseScope,
  type CapabilityExecutionShape,
  type ProviderCapabilityRecord,
  type ProviderHealthRecord,
  type ProviderLimitRecord,
  type ProviderMaturity,
  type ProviderRecord,
  type TransitionEvent,
  type TransitionResult,
  CAPABILITY_EXECUTION_SHAPES,
  DEFAULT_CAPABILITY_EXECUTION_SHAPE,
  isCapabilityExecutionShape,
  type DeliveryVerificationRecord,
  type SettlementAccountAttestation,
  type TreasuryAccountRecord,
  type TreasuryBalanceObservation,
} from "./repo";
export { SupersedingReceiptConflictError } from "./repo";

export { InMemoryConsumerStore } from "./repo-memory";
export { PgConsumerStore } from "./repo-pg";
export { createPool, runMigrations, readSchemaState, type Pool, type SchemaState } from "./db";

export {
  type ExecutionPolicyConfig,
  type RailKey,
  type RailKeys,
  type RailRpcConfig,
  type StorageConfig,
  FEE_BPS,
  FUNDING_CHAIN,
  MissingEnvError,
  SPREAD_BPS,
  feeBpsFor,
  isWellKnownDevKey,
  checkSolanaSecretKey,
  decodeBase58,
  encodeBase58,
  solanaMintAllowlist,
  SOLANA_USDC_MINT,
  type SolanaKeyCheck,
  loadExecutionPolicy,
  loadPublicBaseUrl,
  loadRailKeys,
  loadRailRpc,
  loadSiwxKey,
  loadStorageConfig,
} from "./config";

export {
  type ConsumerFlags,
  type ExecutionBlockReason,
  type GateInput,
  type GateResult,
  assetFlagName,
  assetFlagNames,
  chainFlagName,
  chainFlagNames,
  checkExecutionFlags,
  describeFlags,
  flagOn,
  loadConsumerFlags,
  providerFlagName,
} from "./flags";

export {
  type MaturityGate,
  type PublicToolState,
  type RegistryDeps,
  type ResolvedProvider,
  ProviderRegistry,
  compareMaturity,
  firstEngagedPause,
  maturityAtLeast,
  publicToolState,
  publicToolStateFor,
  resolveExecutionShape,
  railExecutionEnabled,
  railHasStandingSigner,
  railSignerConfigured,
} from "./registry";

export {
  type SettlementAccountDefect,
  type SettlementAccountFunding,
  type SettlementAccountSoundness,
  SETTLEMENT_REGISTRATION_VERSION,
  classifySettlementAccount,
  classifySettlementFunding,
} from "./settlement-account";

export {
  type PauseChecker,
  type PaymentCapability,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
  type Rebalancer,
  type TreasuryRouterDeps,
  NoopRebalancer,
  StorePauseChecker,
  TreasuryRouter,
  assertRebalancingDisabled,
} from "./treasury";

/**
 * The account model (migration 015).
 *
 * Exported beside the store rather than from a new package because it shares the pool, the migration
 * runner and the tenancy vocabulary — and because a second package would need its own lockfile entry
 * to say something the existing one already says.
 */
export {
  AccountAuthorityError,
  PgAccountStore,
  newAccountId,
  newChannelBindingId,
  newDraftId,
  newMarketplaceBindingId,
  newWalletBindingId,
  normaliseAddress,
  resolveScope,
  type AccountStatus,
  type AccountStore,
  type BindingScope,
  type BindingStatus,
  type ChainKind,
  type ChannelBinding,
  type ChannelKind,
  type MarketplaceBinding,
  type MarketplaceBindingStatus,
  type MarketplaceProof,
  type PolicyDraft,
  type PolicyDraftStatus,
  type PolicyLinkKind,
  type Provenance,
  type ResolvedScope,
  type UntchAccount,
  type WalletBinding,
  type WalletBindingKind,
  type AgenticWalletFacts,
  type ChallengeTransport,
  type WalletBindingExtras,
  type WalletProofKind,
  type WalletRole,
} from "./accounts";

/**
 * Account linking (migration 016) — the one-time code that binds an identity and never a payment.
 *
 * Beside the account model for the same reason it is: same pool, same migration set, same vocabulary.
 */
export {
  LINK_CODE_TTL_MS,
  LINK_MAX_ATTEMPTS,
  PgLinkRequestStore,
  canonicaliseCode,
  codeMatches,
  hashCode,
  newLinkCode,
  newLinkRequestId,
  returnUrlAllowed,
  type CreatedLinkRequest,
  type LinkRequest,
  type LinkRequestContext,
  type LinkRequestStatus,
  type LinkRequestStore,
  type LinkKind,
  type AgentStage,
  type RedeemFailure,
  type RedeemOutcome,
} from "./account-link";

/**
 * Approvals (migration 017) — a decision that names the exact payment it authorises.
 *
 * The digest is the whole point and it lives here rather than in the escalation package, because that
 * package is the TRANSPORT half: it knows how to reach a person and how to check they were allowed to
 * answer. What is being answered is a property of the intent and the quote, which is this package's
 * vocabulary.
 */
/**
 * The payment half of an approval (migration 028).
 *
 * Separate from `./approvals` because the two answer different questions. That module answers "what
 * exactly was agreed to". This one answers "was the service fee that bought the right to ask actually
 * paid", which the x402 lifecycle makes a genuinely hard question: the handler commits before
 * settlement runs, and `processSettlement` reports a pending settlement as a successful one.
 */
export {
  APPROVAL_DIGEST_SCHEMA_VERSION,
  type ApprovalSettlementBinding,
} from "./approvals";
export {
  PgServiceCallStore,
  SettlementEvidenceError,
  authorizationDigest,
  finalizeSettlement,
  newApprovalOutboxEventId,
  newPaymentAttemptId,
  newServiceCallId,
  requestFingerprint,
  type AuthorizedTerms,
  type FinalizeResult,
  type PaymentAttemptRow,
  type PaymentAttemptState,
  type ServiceCallIdentity,
  type ServiceCallRow,
  type ServiceCallState,
  type ServiceCallTx,
  type SettlementEvidence,
} from "./x402-service-calls";
export {
  facilitatorOracle,
  reconcileOnce,
  type ReconcileReport,
  type SettlementOracle,
} from "./x402-reconciler";

export {
  ApprovalError,
  PgApprovalStore,
  approvalDigest,
  describeApprovalState,
  digestMatches,
  newApprovalNonce,
  newApprovalRequestId,
  newDecisionId,
  type ApprovalDecision,
  type ApprovalDelivery,
  type ApprovalRequest,
  type ApprovalState,
  type ApprovalSubject,
  type DecideFailure,
  type DecideOutcome,
  type DecisionChannel,
  type DecisionKind,
  type DeliveryOutcome,
} from "./approvals";

/**
 * The rotation gate. A channel cannot become live on a credential the audit saw.
 *
 * Reports NAMES and states, never values — nothing here can leak a token into a log, a snapshot or a
 * test fixture, because nothing here ever holds one.
 */
export {
  AUDITED_CREDENTIALS,
  channelSendAllowed,
  credentialReport,
  credentialState,
  rotationPlan,
  type CredentialReport,
  type CredentialState,
} from "./credential-state";

/**
 * The activity index (migration 018) — a case-first evidence store, not a block explorer.
 *
 * Organised by what happened rather than by which chain recorded it, because one decision produces
 * evidence on three rails and in two databases, and a per-chain view shows five unrelated rows.
 */
export {
  PgActivityIndex,
  ZERO_ALLOCATION,
  netRevenue,
  newCaseId,
  newEventId,
  passThrough,
  publicTimeline,
  type ActivityCase,
  type ActivityEvent,
  type AllocationStatus,
  type CaseKind,
  type CaseState,
  type EventSource,
  type IndexedTransaction,
  type RawChainEvent,
  type Reconciliation,
  type RevenueAllocation,
} from "./activity-index";
export * from "./requester-principal";
export * from "./decision-evidence";
export * from "./requester-presentation";
export * from "./budget-reservation";
export * from "./decision-state";

/**
 * The approval action path (migration 029).
 *
 * The token is what makes a button press into an authorised decision, and the decision function is the
 * one place a human answer becomes financial authority. Kept apart from `./approvals`, which owns what
 * was agreed to, because these own who may agree and what changed while they were deciding.
 */
export {
  APPROVAL_ACTION_TOKEN_VERSION,
  actionTokenFamily,
  actionTokenFingerprint,
  mintApprovalActionToken,
  newActionNonce,
  verifyApprovalActionToken,
  type ActionTokenRefusal,
  type ActionTokenVerdict,
  type ApprovalAction,
  type ApprovalActionClaims,
  type ApprovalActionSubject,
} from "./approval-action-token";
export {
  actOnApproval,
  activeReservedExposure,
  approvalFromMicros,
  approvalToMicros,
  newApprovalDecisionId,
  newReservationId,
  settledGovernedSpend,
  type ApprovalActionInput,
  type ApprovalActionResult,
  type ApprovalOutcome,
  type BudgetSnapshot,
  type ResolvedPolicy,
} from "./approval-decision";
export {
  deliverOnce,
  newApprovalDeliveryId,
  projectDeliveries,
  type ChannelGateway,
  type DeliveryReport,
  type DeliveryStatus,
  type DeliveryTarget,
  type SendOutcome,
} from "./approval-delivery-worker";
export {
  newQuoteLineageId,
  supersedePriorQuote,
  type SupersessionRefusal,
  type SupersessionResult,
} from "./approval-supersession";
export {
  APPROVAL_CASE_PROJECTION_VERSION,
  NEVER_PUBLIC_CASE_FIELDS,
  approvalCaseProjection,
  type PublicApprovalCase,
} from "./approval-case-projection";
export {
  CHANNEL_LINK_TOKEN_VERSION,
  consumeChannelLink,
  linkTokenFingerprint,
  mintChannelLinkToken,
  newLinkCodeId,
  newLinkedChannelBindingId,
  newLinkNonce,
  readChannelLinkToken,
  type ChannelLinkClaims,
  type ConsumeResult,
  type LinkChannel,
  type LinkRefusal,
  type LinkScope,
  type LinkVerdict,
  type PlatformSubject,
} from "./channel-link-token";
export {
  ensureWebApprovalBinding,
  newWebBindingId,
  webChannelSubject,
  type WebBindingRefusal,
  type WebBindingResult,
} from "./web-approval-binding";
