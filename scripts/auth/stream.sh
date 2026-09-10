# Stage 0A / gate 5 — helpers for inspecting gzip'd dumps under `set -euo pipefail`.
#
# The trap these avoid: `zcat f | grep -q PATTERN` makes grep exit at its
# first match, zcat is then killed by SIGPIPE (status 141), and pipefail
# turns a successful match into a failed pipeline. The first production
# gate 5 run died of exactly that ("auth dump missing table user").
#
# The rule here is: every consumer reads the WHOLE stream (grep -c, grep -o,
# tail), so the producer always finishes on its own, and each stage's exit
# status is then checked explicitly through PIPESTATUS. Nothing is masked:
#   - zcat failure (corrupt / truncated gzip)  -> hard failure
#   - grep status 1 (zero matches)             -> legitimate count of 0
#   - grep status >1 (bad pattern, I/O error)  -> hard failure
# No global SIGPIPE suppression, no `|| true`.

# gz_count FILE PATTERN [grep-opts…] — number of lines in FILE matching PATTERN.
gz_count() {
  local file="$1" pattern="$2"; shift 2
  local n st_zcat st_grep
  n="$(zcat "$file" | grep -c "$@" -- "$pattern"; echo " ${PIPESTATUS[0]} ${PIPESTATUS[1]}")"
  st_grep="${n##* }"; n="${n% *}"; st_zcat="${n##* }"; n="${n% *}"
  case "$st_grep" in 0|1) ;; *) echo "FAIL: grep failed (status $st_grep) while scanning $file — bad pattern or I/O error" >&2; return 1;; esac
  [ "$st_zcat" = "0" ] || { echo "FAIL: zcat $file failed (status $st_zcat) — corrupt or truncated archive" >&2; return 1; }
  printf '%s\n' "$n"
}

# gz_matches FILE PATTERN [grep-opts…] — the matched text of every match (grep -o), one per line.
gz_matches() {
  local file="$1" pattern="$2"; shift 2
  local out st_zcat st_grep
  out="$(zcat "$file" | grep -o "$@" -- "$pattern"; echo "@@ ${PIPESTATUS[0]} ${PIPESTATUS[1]}")"
  st_grep="${out##* }"; out="${out% *}"; st_zcat="${out##* }"; out="${out%@@*}"
  case "$st_grep" in 0|1) ;; *) echo "FAIL: grep failed (status $st_grep) while scanning $file — bad pattern or I/O error" >&2; return 1;; esac
  [ "$st_zcat" = "0" ] || { echo "FAIL: zcat $file failed (status $st_zcat) — corrupt or truncated archive" >&2; return 1; }
  printf '%s' "$out"
}

# gz_tail_count FILE N PATTERN — matches of PATTERN within the last N lines of FILE.
gz_tail_count() {
  local file="$1" lines="$2" pattern="$3"
  local n st_zcat st_tail st_grep
  n="$(zcat "$file" | tail -n "$lines" | grep -c -- "$pattern"; echo " ${PIPESTATUS[0]} ${PIPESTATUS[1]} ${PIPESTATUS[2]}")"
  st_grep="${n##* }"; n="${n% *}"; st_tail="${n##* }"; n="${n% *}"; st_zcat="${n##* }"; n="${n% *}"
  case "$st_grep" in 0|1) ;; *) echo "FAIL: grep failed (status $st_grep) on $file — bad pattern or I/O error" >&2; return 1;; esac
  [ "$st_tail" = "0" ] || { echo "FAIL: tail failed (status $st_tail) on $file" >&2; return 1; }
  [ "$st_zcat" = "0" ] || { echo "FAIL: zcat $file failed (status $st_zcat) — corrupt or truncated archive" >&2; return 1; }
  printf '%s\n' "$n"
}

# list_has LIST ITEM — exact-line membership in a newline-separated list, no pipes at all.
list_has() {
  [[ $'\n'"$1"$'\n' == *$'\n'"$2"$'\n'* ]]
}
