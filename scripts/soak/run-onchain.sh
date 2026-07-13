#!/usr/bin/env bash
# Orchestrates the on-chain soak layer (PRD §28) against an anvil FORK of X Layer testnet (1952):
#   1. fork the live testnet at its current block
#   2. run the harness (spends + withhold proof + pause drill + oracle-rotation drill)
#   3. independently re-read the vault's persisted state with raw `cast` (NOT the harness's report)
#   4. tear the fork down
# Evidence lands in internal/day0/soak-evidence/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVID="$ROOT/internal/day0/soak-evidence"
PORT="${PORT:-8599}"
RPC="http://127.0.0.1:$PORT"
FORK_URL="${FORK_URL:-https://testrpc.xlayer.tech}"
VAULT="0x42e699ffd8215d48397a049b4f7a176db06f4848"
TOKEN="0xf202ce41d76ee1a2aec72e7a9180331d437ddd41"
mkdir -p "$EVID"

echo "── forking X Layer testnet 1952 at $FORK_URL (port $PORT) ──"
anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "fork chainId: $(cast chain-id --rpc-url "$RPC")  block: $(cast block-number --rpc-url "$RPC")"

echo "── running harness ──"
RPC_URL="$RPC" npx tsx "$ROOT/scripts/soak/onchain.ts" | tee "$EVID/onchain.json"

echo "── INDEPENDENT raw-RPC readback via cast (post-drills final state) ──"
{
  echo "# Independent raw-RPC readback of the REAL vault on the fork, via cast (not the harness's report)."
  echo "# Captured $(cast block-number --rpc-url "$RPC")=blockNumber on chainId $(cast chain-id --rpc-url "$RPC")"
  echo "vault:            $VAULT"
  echo "owner():          $(cast call $VAULT 'owner()(address)' --rpc-url "$RPC")"
  echo "oracle():         $(cast call $VAULT 'oracle()(address)' --rpc-url "$RPC")"
  echo "paused():         $(cast call $VAULT 'paused()(bool)' --rpc-url "$RPC")"
  echo "perTxCap():       $(cast call $VAULT 'perTxCap()(uint256)' --rpc-url "$RPC")"
  echo "epochBudget():    $(cast call $VAULT 'epochBudget()(uint256)' --rpc-url "$RPC")"
  echo "epochSpent():     $(cast call $VAULT 'epochSpent()(uint256)' --rpc-url "$RPC")"
  echo "requireAnchored:  $(cast call $VAULT 'requireAnchoredIntent()(bool)' --rpc-url "$RPC")"
  echo "tokenAllowed(T):  $(cast call $VAULT "tokenAllowed(address)(bool)" $TOKEN --rpc-url "$RPC")"
  echo "payee BEEF bal:   $(cast call $TOKEN 'balanceOf(address)(uint256)' 0x000000000000000000000000000000000000bEEF --rpc-url "$RPC")"
} | tee "$EVID/onchain-independent-readback.txt"

echo "── done ──"
