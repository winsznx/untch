#!/usr/bin/env bash
#
# Which address does this private key control?
#
# Reads the key with `read -s`, so it is never echoed to the terminal and never lands in shell
# history — unlike `cast wallet address --private-key 0x...`, which leaves the key sitting in
# ~/.zsh_history in plaintext for anyone who later reads that file.
#
# The key is held in a shell variable for the duration of one command and is never written to disk.
#
#   bash scripts/whoami-key.sh
#
# Then paste the key at the prompt (nothing will appear as you type) and press enter.

set -euo pipefail

# The addresses that matter, so the answer is immediate rather than something to eyeball.
ADMIN="0xD9eD4D474B0D01031d10d637546450F39ed6a5ba"

declare -a KNOWN_ADDR=(
  "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba"
  "0x0e79371813e88F31c2B60C80bad391a952039095"
  "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b"
  "0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5"
  "0xeeDda7D18A34A93F3A722eb4446A526Af515457A"
  "0xb29516C8c5dFC29A9E3f68f6e92fd1B6c7612d61"
  "0xC8f00BD8c0497c03dFA9aCF71b061512065923d4"
)
declare -a KNOWN_ROLE=(
  "x402 payTo + UntchReceipts ADMIN  <<< THIS IS THE ONE YOU NEED"
  "Base settlement treasury (CONSUMER_TREASURY_BASE_PRIVATE_KEY)"
  "operator / policy owner (OPERATOR_PRIVATE_KEY)"
  "receipt writer (WRITER_PRIVATE_KEY)"
  "intent writer (INTENT_WRITER_PRIVATE_KEY)"
  "vault oracle (ORACLE_PRIVATE_KEY)"
  "external test funder (local .env)"
)

printf 'Paste the private key (input hidden), then press enter: '
read -rs PK
printf '\n\n'

# Tolerate a missing 0x prefix and stray whitespace — a key copied out of a note usually has both.
PK="$(printf '%s' "$PK" | tr -d '[:space:]')"
[[ "$PK" == 0x* ]] || PK="0x${PK}"

if ! [[ "$PK" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "That is not a 32-byte hex private key (expected 0x + 64 hex characters)."
  unset PK
  exit 1
fi

ADDR="$(cast wallet address --private-key "$PK")"
unset PK   # gone from the shell as soon as it is no longer needed

echo "address: $ADDR"
echo ""

for i in "${!KNOWN_ADDR[@]}"; do
  if [[ "$(printf '%s' "$ADDR" | tr 'A-Z' 'a-z')" == "$(printf '%s' "${KNOWN_ADDR[$i]}" | tr 'A-Z' 'a-z')" ]]; then
    echo "MATCH → ${KNOWN_ROLE[$i]}"
    if [[ "$(printf '%s' "$ADDR" | tr 'A-Z' 'a-z')" == "$(printf '%s' "$ADMIN" | tr 'A-Z' 'a-z')" ]]; then
      echo ""
      echo "This is the UntchReceipts admin. Add it to the gitignored .env as:"
      echo "    ADMIN_PRIVATE_KEY=<the key>"
      echo "and it can propose the receipt writer."
    fi
    exit 0
  fi
done

echo "No match — this key is not one of the seven wallets Untch uses."
