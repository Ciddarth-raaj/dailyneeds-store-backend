#!/usr/bin/env python3
"""
Make nginx redirect plain HTTP for the API host to HTTPS (Stage 0A gate 12).

Finds the server block(s) that serve `server_name` on port 80 in the files
nginx actually loads and makes them answer every request with
`301 https://$host$request_uri`:

  * a block that listens ONLY on 80 gets a plain `return 301 ...;`
  * a block that listens on 80 AND 443 (one combined block) gets
    `if ($scheme = http) { return 301 ...; }` so HTTPS keeps proxying
  * a block that already returns 301/308 to https is left alone
  * if NO block serves the name on port 80 (a catch-all is answering), a
    new file with a dedicated listen-80 block is written next to the file
    holding the 443 block; nginx prefers an exact server_name over a
    default_server catch-all

The 443 configuration is never touched. Every edited file is backed up,
`nginx -t` must pass before reload, the redirect is verified over loopback
after reload, and on any failure every file is restored and nginx reloaded
again on the previous configuration.

Run as root:
  sudo python3 patch_nginx_http_redirect.py --dry-run [server_name]   # show the plan, change nothing
  sudo python3 patch_nginx_http_redirect.py [server_name]             # apply + verify
"""

import difflib
import os
import re
import shutil
import subprocess
import sys
import time

DEFAULT_SERVER_NAME = "api.dnds.co.in"
REDIRECT = "return 301 https://$host$request_uri;"


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def loaded_config_files():
    """Only the files nginx actually loads, so a stale copy is never edited."""
    if os.environ.get("NGINX_TEST_FILES"):  # unit tests: no nginx binary
        return os.environ["NGINX_TEST_FILES"].split(":")
    result = run(["nginx", "-T"])
    if result.returncode != 0:
        sys.exit(f"nginx -T failed, refusing to edit anything:\n{result.stderr}")
    paths = re.findall(r"(?m)^# configuration file (.+):$", result.stdout)
    return sorted(set(paths))


def blank_comments(text):
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


def listens(body_scan):
    """Set of ports a server block listens on, from every `listen` directive."""
    ports = set()
    for m in re.finditer(r"(?m)^[ \t]*listen\s+([^;]*);", body_scan):
        spec = m.group(1).strip()
        first = spec.split()[0]
        port = first.rsplit(":", 1)[-1] if ":" in first else first
        port = port.strip("[]")
        if port.isdigit():
            ports.add(int(port))
        elif "ssl" in spec:
            ports.add(443)
        if " ssl" in f" {spec} ":
            ports.add(443)
    return ports


def names_of(body_scan, text_offset, text):
    m = re.search(r"(?m)^[ \t]*server_name([^;]*);", body_scan)
    if not m:
        return set(), None
    raw = text[text_offset + m.start(1): text_offset + m.end(1)]
    return set(raw.split()), m


def already_redirects(body_scan):
    return re.search(r"return\s+30[18]\s+https://", body_scan) is not None


def plan(text, server_name):
    """
    Returns (edits, notes, has_443_block). edits = [(offset, insertion)],
    right-most first so applying back to front keeps offsets valid.
    """
    scan = blank_comments(text)
    edits, notes = [], []
    has_443 = False
    for _, srv_open, srv_close in find_blocks(scan, "server"):
        body_scan = scan[srv_open:srv_close]
        names, name_match = names_of(body_scan, srv_open, text)
        if server_name not in names:
            continue
        ports = listens(body_scan)
        line = text[:srv_open].count("\n") + 1
        if 443 in ports:
            has_443 = True
        if 80 not in ports:
            continue
        if already_redirects(body_scan):
            notes.append(f"line {line}: server block for {server_name} on :80 already redirects to https — left alone")
            continue
        # insert after the END of the server_name line, so a trailing comment stays put
        eol = text.find("\n", srv_open + name_match.end())
        at = eol if eol != -1 else srv_open + name_match.end()
        indent = indent_of_offset(text, srv_open + name_match.start())
        if 443 in ports:
            insertion = (f"\n{indent}# Stage 0A gate 12: plain HTTP must not serve the API\n"
                         f"{indent}if ($scheme = http) {{ {REDIRECT} }}")
            notes.append(f"line {line}: combined :80/:443 block — adding scheme-conditional redirect")
        else:
            insertion = (f"\n{indent}# Stage 0A gate 12: plain HTTP must not serve the API\n"
                         f"{indent}{REDIRECT}")
            notes.append(f"line {line}: :80-only block — adding unconditional redirect")
        edits.append((at, insertion))
    edits.sort(key=lambda e: e[0], reverse=True)
    return edits, notes, has_443


def new_redirect_file(server_name):
    return (
        "# Stage 0A gate 12: plain HTTP for the API host answers only with a redirect.\n"
        "# Added by scripts/patch_nginx_http_redirect.py; the HTTPS server block is elsewhere and untouched.\n"
        "server {\n"
        "    listen 80;\n"
        "    listen [::]:80;\n"
        f"    server_name {server_name};\n"
        f"    {REDIRECT}\n"
        "}\n"
    )


def verify(server_name):
    """Loopback checks: 80 redirects, 443 still answers with a non-5xx."""
    r = run(["curl", "-s", "-o", "/dev/null", "-m", "8", "-w", "%{http_code} %{redirect_url}",
             "-H", f"Host: {server_name}", "http://127.0.0.1/user/my-ip"])
    code, _, location = r.stdout.partition(" ")
    ok80 = code in ("301", "308") and location.startswith(f"https://{server_name}/user/my-ip")
    r2 = run(["curl", "-s", "-o", "/dev/null", "-m", "8", "-k", "-w", "%{http_code}",
              "--resolve", f"{server_name}:443:127.0.0.1", f"https://{server_name}/user/my-ip"])
    ok443 = r2.stdout[:1] in ("2", "3", "4")  # 403 (token required) is the expected answer today
    print(f"verify: http://{server_name}/user/my-ip -> {code} {location or '(no Location)'}   [{'OK' if ok80 else 'FAIL'}]")
    print(f"verify: https://{server_name}/user/my-ip -> {r2.stdout or '(no answer)'}   [{'OK' if ok443 else 'FAIL'}]")
    return ok80 and ok443


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    server_name = args[0] if args else DEFAULT_SERVER_NAME
    testing = bool(os.environ.get("NGINX_TEST_FILES"))
    if os.geteuid() != 0 and not testing and not dry_run:
        sys.exit("Must run as root (nginx config is not world-writable).")

    print(f"server_name: {server_name}   mode: {'DRY RUN (no changes)' if dry_run else 'apply'}\n")
    files = loaded_config_files()
    targets = [p for p in files if server_name in open(p, errors="replace").read()]
    if not targets:
        sys.exit(f"No loaded nginx config mentions {server_name}. Nothing changed.")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    changed, planned_any, any_443_file = [], False, None
    for path in targets:
        original = open(path).read()
        edits, notes, has_443 = plan(original, server_name)
        if has_443 and any_443_file is None:
            any_443_file = path
        for n in notes:
            print(f"{path}: {n}")
        if not edits:
            continue
        planned_any = True
        updated = original
        for at, insertion in edits:
            updated = updated[:at] + insertion + updated[at:]
        diff = difflib.unified_diff(original.splitlines(), updated.splitlines(),
                                    fromfile=f"{path} (before)", tofile=f"{path} (after)", lineterm="", n=2)
        print("\n".join(diff) + "\n")
        if not dry_run:
            backup = f"{path}.bak-{stamp}"
            shutil.copy2(path, backup)
            with open(path, "w") as h:
                h.write(updated)
            changed.append((path, backup, False))

    if not planned_any:
        # nothing served the name on :80 (or everything already redirects)
        already = any("already redirects" in n for p in targets for n in plan(open(p).read(), server_name)[1])
        if already:
            print("Nothing to change — the redirect is already in place.")
            return
        if not any_443_file:
            sys.exit(f"No server block for {server_name} found on :80 or :443. Nothing changed.")
        new_path = os.path.join(os.path.dirname(any_443_file), f"00-{server_name.replace('.', '-')}-http-redirect.conf")
        print(f"No server block serves {server_name} on :80 (a catch-all answers it). Adding {new_path}:\n")
        print(new_redirect_file(server_name))
        if not dry_run:
            if os.path.exists(new_path):
                sys.exit(f"{new_path} already exists — refusing to overwrite.")
            with open(new_path, "w") as h:
                h.write(new_redirect_file(server_name))
            changed.append((new_path, None, True))

    if dry_run:
        print("Dry run: no file written, nothing reloaded.")
        return
    if testing:
        return

    def restore():
        for path, backup, created in changed:
            if created:
                os.remove(path)
            else:
                shutil.copy2(backup, path)

    print("Validating...")
    test = run(["nginx", "-t"])
    print(test.stderr or test.stdout)
    if test.returncode != 0:
        restore()
        sys.exit("nginx -t FAILED. Every file was restored; nothing reloaded.")

    reload_result = run(["systemctl", "reload", "nginx"])
    if reload_result.returncode != 0:
        restore()
        run(["systemctl", "reload", "nginx"])
        sys.exit(f"Reload failed, config restored:\n{reload_result.stderr}")
    print("nginx reloaded. Verifying over loopback...")

    if not verify(server_name):
        restore()
        run(["systemctl", "reload", "nginx"])
        sys.exit("Verification FAILED: previous configuration restored and reloaded.")

    print("\nDone. Plain HTTP now redirects; HTTPS unchanged.")
    for path, backup, created in changed:
        print(f"  {'created' if created else 'edited'}: {path}" + (f"   backup: {backup}" if backup else ""))


if __name__ == "__main__":
    main()
