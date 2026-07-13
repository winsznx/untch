import { getAddress, isAddress, type Address } from "viem";

/**
 * Shared role-separation primitives for the §28 key-custody gates. Pure address logic — no keys, no
 * network. Consumed by `verify-role-separation.ts` (the pre-deploy distinctness gate) and
 * `verify-deployment-roles.ts` (the post-deploy on-chain readback assertion).
 */

export const ROLES = ["deployer", "owner", "admin", "writer", "oracle"] as const;
export type Role = (typeof ROLES)[number];

/** The env var each role's PUBLIC address is read from. Public addresses only — never a private key. */
export const ROLE_ENV: Record<Role, string> = {
  deployer: "DEPLOYER_ADDRESS",
  owner: "OWNER_ADDRESS",
  admin: "ADMIN_ADDRESS",
  writer: "WRITER_ADDRESS",
  oracle: "ORACLE_ADDRESS",
};

export interface RoleReadResult {
  readonly addresses: Record<Role, Address>;
  readonly missing: Role[];
  readonly malformed: { role: Role; value: string }[];
}

/** Read + validate the five role addresses from `env`. Never throws — reports problems structurally. */
export function readRoleAddresses(env: NodeJS.ProcessEnv): RoleReadResult {
  const addresses = {} as Record<Role, Address>;
  const missing: Role[] = [];
  const malformed: { role: Role; value: string }[] = [];
  for (const role of ROLES) {
    const raw = env[ROLE_ENV[role]]?.trim();
    if (!raw) {
      missing.push(role);
      continue;
    }
    if (!isAddress(raw)) {
      malformed.push({ role, value: raw });
      continue;
    }
    addresses[role] = getAddress(raw);
  }
  return { addresses, missing, malformed };
}

export interface PairCheck {
  readonly a: Role;
  readonly b: Role;
  readonly addrA: Address;
  readonly addrB: Address;
  readonly distinct: boolean;
}

/** All C(5,2)=10 role pairs, each flagged distinct/colliding (checksum-normalized comparison). */
export function pairwiseDistinct(addresses: Record<Role, Address>): PairCheck[] {
  const checks: PairCheck[] = [];
  for (let i = 0; i < ROLES.length; i++) {
    for (let j = i + 1; j < ROLES.length; j++) {
      const a = ROLES[i]!;
      const b = ROLES[j]!;
      const addrA = addresses[a];
      const addrB = addresses[b];
      checks.push({ a, b, addrA, addrB, distinct: addrA.toLowerCase() !== addrB.toLowerCase() });
    }
  }
  return checks;
}

export function eq(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
