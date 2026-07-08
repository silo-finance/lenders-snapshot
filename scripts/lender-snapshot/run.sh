#!/usr/bin/env bash
# Build (if needed) and run a lender-snapshot script inside Docker, so it works
# regardless of the local Python setup.
#
# Usage:
#   ./run.sh snapshot_lenders.py <category-slug>   # scan one category (slug REQUIRED)
#   ./scripts/lender-snapshot/run.sh snapshot_lenders.py pendle
#   ./scripts/lender-snapshot/run.sh snapshot_lenders.py trevee
#   ./scripts/lender-snapshot/run.sh snapshot_lenders.py stream
#   ./run.sh qa_check.py                           # runs the QA validator
#   ./run.sh qa_check.py --verify-onchain
#
# Secrets: the script auto-loads ./.env (mounted into the container). You may
# alternatively export {CHAIN}_RPC_URL / RPC_URL / THE_GRAPH_API_KEY in your shell and they will
# be forwarded into the container (and take precedence over .env).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="lender-snapshot:latest"

# Build the image (Docker caches layers, so this is fast after the first run).
docker build -t "$IMAGE" "$HERE" 1>&2

# Forward secrets from the host environment if present (optional; .env also works).
ENV_ARGS=()
if [ -n "${RPC_URL:-}" ]; then ENV_ARGS+=(-e "RPC_URL=${RPC_URL}"); fi
if [ -n "${SONIC_RPC_URL:-}" ]; then ENV_ARGS+=(-e "SONIC_RPC_URL=${SONIC_RPC_URL}"); fi
if [ -n "${ETHEREUM_RPC_URL:-}" ]; then ENV_ARGS+=(-e "ETHEREUM_RPC_URL=${ETHEREUM_RPC_URL}"); fi
if [ -n "${THE_GRAPH_API_KEY:-}" ]; then ENV_ARGS+=(-e "THE_GRAPH_API_KEY=${THE_GRAPH_API_KEY}"); fi

SCRIPT="${1:-snapshot_lenders.py}"
if [ "$#" -gt 0 ]; then shift; fi

# Mount the task dir so outputs (data/<slug>.json) land on the host.
# ${ENV_ARGS[@]+...} keeps this safe under `set -u` with macOS bash 3.2.
docker run --rm \
  -v "$HERE":/app \
  -w /app \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  "$IMAGE" \
  python -u "$SCRIPT" "$@"
