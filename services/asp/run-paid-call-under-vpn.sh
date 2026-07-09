#!/usr/bin/env bash
# D0.1 — run ONE real paid x402 call while the VPN is on, capturing everything to a log so it
# can be verified after the VPN is turned off. Self-contained: needs no live agent connection.
#
# Usage (in a plain Terminal, VPN ON, from anywhere):
#   bash /Users/mac/untch/services/asp/run-paid-call-under-vpn.sh
# Then turn the VPN OFF and hand the printed log path back.
set -uo pipefail
cd "$(dirname "$0")"

TS=$(date +%Y%m%d-%H%M%S)
LOG="../../internal/day0/D0.1-evidence/vpn-run-$TS.log"
mkdir -p "$(dirname "$LOG")"
exec > >(tee "$LOG") 2>&1

echo "======================================================================"
echo " D0.1 paid-call run under VPN — $TS"
echo "======================================================================"

echo "--- 1. exit IP / country (must NOT be Lagos / MTN Nigeria if the VPN is routing) ---"
curl -s -m 15 https://ipinfo.io/json | grep -E '"ip"|"country"|"region"|"org"' || echo "ipinfo unreachable"

echo
echo "--- 2. OKX host reachability (web3.okx.com — the facilitator lives here) ---"
code=$(curl -sI -m 25 -o /dev/null -w '%{http_code}' https://web3.okx.com/ 2>/dev/null)
echo "web3.okx.com -> http_code=$code"
if [ "$code" = "000" ]; then
  echo
  echo "STILL BLOCKED from this VPN exit (SYN dropped). Try a DIFFERENT Windscribe region"
  echo "(avoid US; try UK / EU / Singapore). NOT running the paid call — nothing was charged."
  echo "=== END (blocked, exit 3) ==="
  exit 3
fi

echo
echo "--- 3. OKX reachable. Executing exactly ONE real paid call (pnpm pay) ---"
pnpm pay
rc=$?
echo
echo "=== pnpm pay exit code: $rc ==="
echo "Evidence JSON (if the call settled): internal/day0/D0.1-evidence/paid-call-transcript.json"
echo "Log saved to: $LOG"
echo "=== END ==="
exit $rc
