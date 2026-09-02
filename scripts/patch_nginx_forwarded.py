#!/usr/bin/env python3
"""
Teach nginx to forward the client's IP to the API.

The app resolves a caller's address from `X-Forwarded-For`. Without that
header nginx proxies over localhost and Express falls back to the socket
address, so every request looks like it came from 127.0.0.1 and the
per-user IP restriction cannot tell one caller from another.

This adds the forwarding headers to the location blocks that proxy the
target server_name, then validates and reloads. It is idempotent: a
location that already sets X-Forwarded-For is left alone, so re-running
is a no-op.

Run as root:  sudo python3 patch_nginx_forwarded.py [server_name]
"""

import difflib
import os
import re
import shutil
import subprocess
import sys
import time

DEFAULT_SERVER_NAME = "api.dnds.co.in"

# `$remote_addr` rather than `$proxy_add_x_forwarded_for` deliberately.
# The latter appends to whatever the client sent, and the app reads the
# left-most entry, so a client could send a header of its own and choose
# the address it appears to come from — defeating the restriction. This
# overwrites, so the header only ever carries what nginx itself saw.
HEADERS = [
    ("Host", "$host"),
    ("X-Real-IP", "$remote_addr"),
    ("X-Forwarded-For", "$remote_addr"),
    ("X-Forwarded-Proto", "$scheme"),
]


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def loaded_config_files():
    """Only the files nginx actually loads, so we never edit a stale copy."""
    result = run(["nginx", "-T"])
    if result.returncode != 0:
        sys.exit(f"nginx -T failed, refusing to edit anything:\n{result.stderr}")
    paths = re.findall(r"(?m)^# configuration file (.+):$", result.stdout)
    return sorted(set(paths))


def blank_comments(text):
    """
    Replace comments with spaces, keeping length so offsets still line up.

    Brace matching has to ignore a `}` inside a comment, but every edit is
    made against the original text.
    """
    out = list(text)
    i = 0
    while i < len(text):
        if text[i] == "#":
            while i < len(text) and text[i] != "\n":
                out[i] = " "
                i += 1
        else:
            i += 1
    return "".join(out)


def find_blocks(scan, keyword):
    """(header_start, brace_open, brace_close) for each `keyword ... { }`."""
    found = []
    for match in re.finditer(r"(?m)^[ \t]*" + keyword + r"\b[^{;]*\{", scan):
        opening = scan.index("{", match.end() - 1)
        depth = 0
        for i in range(opening, len(scan)):
            if scan[i] == "{":
                depth += 1
            elif scan[i] == "}":
                depth -= 1
                if depth == 0:
                    found.append((match.start(), opening, i))
                    break
    return found


def indent_of_offset(text, offset):
    line_start = text.rfind("\n", 0, offset) + 1
    return re.match(r"[ \t]*", text[line_start:]).group(0)


def plan_edits(text, server_name):
    """
    Insertion points for a file, right-most first.

    Applying them back to front keeps earlier offsets valid.
    """
    scan = blank_comments(text)
    edits = []
    skipped = []

    for _, srv_open, srv_close in find_blocks(scan, "server"):
        body_scan = scan[srv_open:srv_close]

        name = re.search(r"(?m)^[ \t]*server_name[^;]*;", body_scan)
        if not name:
            continue
        if server_name not in text[srv_open + name.start(): srv_open + name.end()]:
            continue

        for _, loc_open, loc_close in find_blocks(body_scan, "location"):
            loc_scan = body_scan[loc_open:loc_close]
            if "proxy_pass" not in loc_scan:
                continue  # a static or redirect location proxies nothing

            absolute = srv_open + loc_open
            if re.search(r"proxy_set_header\s+X-Forwarded-For", loc_scan, re.I):
                skipped.append(text[:absolute].count("\n") + 1)
                continue

            statement = re.search(r"proxy_pass[^;]*;", loc_scan)
            if not statement:
                continue

            at = absolute + statement.end()
            indent = indent_of_offset(text, absolute + statement.start())
            block = "".join(
                f"\n{indent}proxy_set_header {name_:<17} {value};"
                for name_, value in HEADERS
            )
            edits.append((at, block))

    edits.sort(key=lambda edit: edit[0], reverse=True)
    return edits, skipped


def main():
    server_name = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SERVER_NAME
    if os.geteuid() != 0:
        sys.exit("Must run as root (nginx config is not world-writable).")

    print(f"Looking for server_name matching: {server_name}\n")

    targets = [p for p in loaded_config_files()
               if server_name in open(p, errors="replace").read()]
    if not targets:
        sys.exit(
            f"No loaded nginx config mentions {server_name}. "
            "Nothing was changed — check the name is right."
        )

    stamp = time.strftime("%Y%m%d-%H%M%S")
    changed = []

    for path in targets:
        original = open(path).read()
        edits, skipped = plan_edits(original, server_name)

        for line in skipped:
            print(f"{path}:{line}: already forwards X-Forwarded-For, left alone")

        if not edits:
            continue

        updated = original
        for at, block in edits:
            updated = updated[:at] + block + updated[at:]

        backup = f"{path}.bak-{stamp}"
        shutil.copy2(path, backup)
        with open(path, "w") as handle:
            handle.write(updated)
        changed.append((path, backup))

        print(f"\n--- {path} ({len(edits)} location block(s) patched)")
        diff = difflib.unified_diff(
            original.splitlines(), updated.splitlines(),
            fromfile=f"{path} (before)", tofile=f"{path} (after)", lineterm="", n=2,
        )
        print("\n".join(diff))

    if not changed:
        print("\nNothing to change — the headers are already in place.")
        return

    print("\nValidating...")
    test = run(["nginx", "-t"])
    print(test.stderr or test.stdout)

    if test.returncode != 0:
        # Never leave a box holding a config nginx rejects.
        for path, backup in changed:
            shutil.copy2(backup, path)
        sys.exit("nginx -t FAILED. Every file was restored from backup; nothing reloaded.")

    reload_result = run(["systemctl", "reload", "nginx"])
    if reload_result.returncode != 0:
        for path, backup in changed:
            shutil.copy2(backup, path)
        run(["systemctl", "reload", "nginx"])
        sys.exit(f"Reload failed, config restored:\n{reload_result.stderr}")

    print("nginx reloaded.")
    for _, backup in changed:
        print(f"Backup kept at {backup}")


if __name__ == "__main__":
    main()
