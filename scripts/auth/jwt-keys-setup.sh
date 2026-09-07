#!/usr/bin/env bash
# Stage 0A / gate 17A — externalise the CURRENT JWT key pair for a staging
# run, and prove that the externally loaded key signs and verifies exactly
# like the tracked one (so tokens issued by the deployed code keep working).
#
# Copies (never moves, never rotates) keys/jwt/private.key and public.key
# from the deployment clone into ~/.stage0a/jwt/ (dir 700, files 600), writes
# ~/.stage0a/jwt.env with the three variables Stage 0A reads, and verifies:
#   1. the external private key and the tracked public key are one pair
#      (sign with external private -> verify with tracked public)
#   2. the external public key verifies a token signed by the tracked private key
#   3. optional: PROBE_TOKEN (a real token from the deployed app, e.g. your
#      own session) verifies with the external public key — proving the
#      production issuer IS this key. The token is never printed.
# Nothing here touches the live process, the deploy clone, or production.
#
# Usage: scripts/auth/jwt-keys-setup.sh [deploy_clone_dir]
set -euo pipefail

DEPLOY="${1:-$HOME/dailyneeds-store-backend}"
DEST="$HOME/.stage0a/jwt"
ENVF="$HOME/.stage0a/jwt.env"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -r "$DEPLOY/keys/jwt/private.key" ] && [ -r "$DEPLOY/keys/jwt/public.key" ] || fail "keys not found under $DEPLOY/keys/jwt"
mkdir -p "$DEST"; chmod 700 "$HOME/.stage0a" "$DEST"
umask 077
cp "$DEPLOY/keys/jwt/private.key" "$DEST/private.key"
cp "$DEPLOY/keys/jwt/public.key"  "$DEST/public.key"
chmod 600 "$DEST/private.key" "$DEST/public.key"

# fingerprints of the PUBLIC key only (a public value; never the private key)
fp() { openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | sha256sum | cut -c1-32; }
echo "public key fingerprint (tracked):  $(fp "$DEPLOY/keys/jwt/public.key")"
echo "public key fingerprint (external): $(fp "$DEST/public.key")"
[ "$(fp "$DEPLOY/keys/jwt/public.key")" = "$(fp "$DEST/public.key")" ] || fail "copy mismatch"
echo "private key: $(stat -c '%a %U' "$DEST/private.key") $(wc -c < "$DEST/private.key") bytes (content never shown)"

cat > "$ENVF" <<EOF
# Stage 0A / gate 17A — external key material for the CURRENT key (kid 'legacy'). Generated $(date '+%Y-%m-%d %H:%M:%S').
JWT_PRIVATE_KEY_PATH=$DEST/private.key
JWT_PUBLIC_KEYS='{"legacy":"$DEST/public.key"}'
JWT_ACTIVE_KID=legacy
EOF
chmod 600 "$ENVF"
echo "env file written: $ENVF"

echo "== verification (node, jsonwebtoken RS256) =="
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
( cd "$HERE/../.." && PROBE_TOKEN="${PROBE_TOKEN:-}" node - "$DEST" "$DEPLOY/keys/jwt" <<'EOF'
const fs = require("fs"); const jwt = require("jsonwebtoken");
const [ext, tracked] = process.argv.slice(2);
const extPriv = fs.readFileSync(ext + "/private.key", "utf8"), extPub = fs.readFileSync(ext + "/public.key", "utf8");
const trPriv = fs.readFileSync(tracked + "/private.key", "utf8"), trPub = fs.readFileSync(tracked + "/public.key", "utf8");
const t1 = jwt.sign({ probe: 1 }, extPriv, { algorithm: "RS256", expiresIn: "1m" });
jwt.verify(t1, trPub, { algorithms: ["RS256"] }); console.log("  1. external private -> tracked public: OK");
const t2 = jwt.sign({ id: 1, employee_id: 1, user_type: 1 }, trPriv, { algorithm: "RS256", expiresIn: "1m" }); // legacy shape, no kid
jwt.verify(t2, extPub, { algorithms: ["RS256"] }); console.log("  2. tracked private (legacy-shaped token, no kid) -> external public: OK");
const probe = process.env.PROBE_TOKEN;
if (probe) {
  try {
    const d = jwt.verify(probe, extPub, { algorithms: ["RS256"] });
    const h = JSON.parse(Buffer.from(probe.split(".")[0], "base64url").toString());
    console.log("  3. PROBE_TOKEN verifies with the external public key: OK  header=" + JSON.stringify(h) + " payload fields=" + Object.keys(d).join(","));
  } catch (e) { console.log("  3. PROBE_TOKEN does NOT verify with this key: " + e.message + "  (production signs with a different key?)"); process.exit(1); }
} else console.log("  3. (no PROBE_TOKEN given — skip; pass a token of your own session to prove production signs with this key)");
EOF
)
echo
echo "To run Stage 0A with the external key:  set -a; . $ENVF; set +a   (the app logs no 'tracked key fallback' warning)"
