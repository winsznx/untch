/**
 * @untch/policy-store — PRD §6.2 / §8 / §10.1 durable policy CRUD, on-chain-anchored.
 *
 * Public surface:
 *   • Write side (the create/update/pause tools): PolicyService, ViemPolicyRegistry, loadOperatorConfig.
 *   • Read side (preflight's policy source): PolicyProvider, PgPolicyRepo, createPool, runMigrations.
 *   • Testing / reuse: InMemoryPolicyRepo, parsePolicyRules, the PolicyRegistryChain interface + fakes.
 */

export {
  loadStorageConfig,
  loadOperatorConfig,
  MissingEnvError,
  POLICY_REGISTRY_DEFAULT,
  X_LAYER_TESTNET_ID,
  X_LAYER_MAINNET_ID,
  xLayerTestnet,
  type StorageConfig,
  type OperatorConfig,
} from "./config";
export { createPool, runMigrations, type Pool } from "./db";
export type {
  StoredPolicy,
  StoredPolicyStatus,
  OnchainRef,
  CreatePolicyResult,
  UpdatePolicyResult,
  PausePolicyResult,
} from "./types";
export { parsePolicyRules, PolicyValidationError } from "./rules";
export {
  ViemPolicyRegistry,
  POLICY_REGISTRY_ABI,
  type PolicyRegistryChain,
  type OnchainPolicy,
  type RegisterResult,
  type MutateResult,
  type ViemPolicyRegistryOptions,
} from "./registry";
export { type PolicyRepo, toEnginePolicy } from "./repo";
export { PgPolicyRepo } from "./repo-pg";
export { InMemoryPolicyRepo } from "./repo-memory";
export {
  PolicyService,
  PolicyNotFoundError,
  type CreatePolicyArgs,
  type UpdatePolicyArgs,
} from "./service";
export { PolicyProvider } from "./provider";
