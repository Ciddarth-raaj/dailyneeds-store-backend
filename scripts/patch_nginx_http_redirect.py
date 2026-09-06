#!/usr/bin/env python3
"""
Make nginx redirect plain HTTP for the API host to HTTPS (Stage 0A gate 12).

Works from `nginx -T` (the configuration nginx is actually running, every
file, in load order) and applies nginx's own server-selection rules to
decide WHICH server block answers `http://<server_name>/` on port 80:

  1. only blocks whose `listen` covers port 80 on the address the request
     arrives on (an address-specific listen beats a wildcard one)
  2. exact server_name match — the FIRST such block in load order wins
     (nginx warns "conflicting server name" about the rest and ignores them)
  3. else longest `*.example` wildcard, else longest `example.*` wildcard
  4. else the first matching `~regex` name
  5. else the `default_server` for that listen, else the first block listed

Only the block proven effective is patched:
  * :80-only block               -> `return 301 https://$host$request_uri;`
  * combined :80/:443 block      -> `if ($scheme = http) { return 301 ...; }`
  * a shared catch-all (`_`)     -> a NEW dedicated exact-name block file
                                    (exact name beats default_server), so
                                    other hosts on the catch-all are unaffected
  * already redirecting          -> no change

Before touching anything it also reports what actually LISTENS on :80
(if it is not nginx, no nginx edit can help) and what the host answers
today. After the edit: backup, `nginx -t`, reload, then verification of
BOTH the loopback path and the public-address path with the real Host
header, checking status AND Location. On any failure every file is
restored and nginx reloaded on the previous configuration.

Run as root:
  sudo python3 patch_nginx_http_redirect.py --dry-run [server_name]   # analysis + plan, no change
  sudo python3 patch_nginx_http_redirect.py [server_name]             # apply + verify
"""

import difflib
import os
import re
import shutil
import socket
import subprocess
import sys
import time

DEFAULT_SERVER_NAME = "api.dnds.co.in"
REDIRECT = "return 301 https://$host$request_uri;"
PROBE_PATH = "/user/my-ip"


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------- nginx -T

def nginx_dump():
    if os.environ.get("NGINX_TEST_DUMP"):
        return open(os.environ["NGINX_TEST_DUMP"]).read()
    r = run(["nginx", "-T"])
    if r.returncode != 0:
        sys.exit(f"nginx -T failed, refusing to edit anything:\n{r.stderr}")
    return r.stdout


def split_dump(dump):
    """[(path, text)] in load order, from the `# configuration file X:` markers."""
    parts = re.split(r"(?m)^# configuration file (.+):$\n", dump)
    files = []
    for i in range(1, len(parts) - 1, 2):
        files.append((parts[i].strip(), parts[i + 1]))
    return files


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


def parse_listen(spec):
    """'80' | '*:80' | '127.0.0.1:80' | '[::]:80 ssl' -> (address, port, ssl, default)"""
    parts = spec.split()
    first = parts[0]
    ssl = "ssl" in parts[1:]
    default = any(p in ("default_server", "default") for p in parts[1:])
    if first.startswith("["):
        addr, _, port = first.rpartition("]:")
        addr = addr.lstrip("[")
        addr = "*" if addr == "::" else addr
    elif ":" in first:
        addr, port = first.rsplit(":", 1)
    elif first.isdigit():
        addr, port = "*", first
    else:
        addr, port = first, ("443" if ssl else "80")
    if not port.isdigit():
        port = "443" if ssl else "80"
    return addr, int(port), ssl, default


class Block:
    def __init__(self, path, text, scan, hs, bo, bc):
        self.path, self.text = path, text
        self.hs, self.bo, self.bc = hs, bo, bc
        self.line = text[:hs].count("\n") + 1
        body = scan[bo:bc]
        self.body_scan = body
        self.listens = [parse_listen(m.group(1).strip()) for m in re.finditer(r"(?m)^[ \t]*listen\s+([^;]*);", body)]
        m = re.search(r"(?m)^[ \t]*server_name([^;]*);", body)
        self.name_match = m
        self.names = text[bo + m.start(1): bo + m.end(1)].split() if m else [""]
        self.redirects = re.search(r"return\s+30[18]\s+https://", body) is not None
        self.proxies = "proxy_pass" in body

    def ports(self):
        return {p for _, p, _, _ in self.listens}

    def listens_on(self, port, address):
        """Sockets this block joins for (port, address): 'exact' address, or 'wildcard'."""
        best = None
        for addr, p, _, _ in self.listens:
            if p != port:
                continue
            if addr == address:
                return "exact"
            if addr == "*":
                best = "wildcard"
        return best

    def is_default_for(self, port):
        return any(p == port and d for _, p, _, d in self.listens)

    def where(self):
        return f"{self.path}:{self.line}"


def all_blocks(files):
    blocks = []
    for path, text in files:
        scan = blank_comments(text)
        for hs, bo, bc in find_blocks(scan, "server"):
            blocks.append(Block(path, text, scan, hs, bo, bc))
    return blocks


def select(blocks, port, address, host):
    """
    (block, reason, candidates) — nginx's choice for a request to
    address:port with Host: host, or (None, reason, candidates).
    """
    joined = [(b, b.listens_on(port, address)) for b in blocks]
    joined = [(b, kind) for b, kind in joined if kind]
    if not joined:
        return None, f"no server block listens on {address}:{port} (or *:{port})", []
    # an address-specific socket takes the request away from the wildcard socket
    if any(kind == "exact" for _, kind in joined) and address != "*":
        cands = [b for b, kind in joined if kind == "exact"]
        sock = f"{address}:{port}"
    else:
        cands = [b for b, _ in joined]
        sock = f"*:{port}"
    h = host.lower()
    exact = [b for b in cands if h in [n.lower() for n in b.names]]
    if exact:
        why = f"exact server_name match on socket {sock}"
        if len(exact) > 1:
            why += f" — {len(exact)} blocks claim this name; nginx uses the FIRST and ignores the others ({', '.join(b.where() for b in exact[1:])})"
        return exact[0], why, cands
    best = None
    for b in cands:
        for n in b.names:
            nl = n.lower()
            if nl.startswith("*.") and h.endswith(nl[1:]) and (best is None or len(nl) > len(best[1])):
                best = (b, nl, "longest leading-wildcard server_name")
    if best:
        return best[0], best[2], cands
    for b in cands:
        for n in b.names:
            nl = n.lower()
            if nl.endswith(".*") and h.startswith(nl[:-1]) and (best is None or len(nl) > len(best[1])):
                best = (b, nl, "longest trailing-wildcard server_name")
    if best:
        return best[0], best[2], cands
    for b in cands:
        for n in b.names:
            if n.startswith("~"):
                try:
                    if re.search(n[1:].lstrip("*"), host, re.I if n.startswith("~*") else 0):
                        return b, f"regex server_name {n}", cands
                except re.error:
                    pass
    for b in cands:
        if b.is_default_for(port):
            return b, f"default_server for socket {sock} (no name matched)", cands
    return cands[0], f"first block listed for socket {sock} (no name matched, no default_server)", cands


# ---------------------------------------------------------------- runtime facts

def listeners_on_80():
    """Processes bound to :80 per ss (or netstat)."""
    r = run(["ss", "-ltnp"])
    if r.returncode != 0:
        r = run(["netstat", "-ltnp"])
    return [l for l in r.stdout.splitlines() if re.search(r":80\s", l)]


def probe(url, host, resolve=None):
    """(status, location, server_header, body_head) for GET url with Host: host."""
    cmd = ["curl", "-s", "-m", "8", "-D", "-", "-o", "/dev/null", "-k", "-H", f"Host: {host}", url]
    if resolve:
        cmd += ["--resolve", resolve]
    r = run(cmd)
    head = r.stdout
    status = re.search(r"HTTP/\S+\s+(\d{3})", head)
    loc = re.search(r"(?im)^location:\s*(\S+)", head)
    srv = re.search(r"(?im)^server:\s*(.+)$", head)
    return (status.group(1) if status else "000", loc.group(1) if loc else "", srv.group(1).strip() if srv else "", head.strip().splitlines()[:1])


def public_addresses():
    addrs = set()
    r = run(["hostname", "-I"])
    for a in r.stdout.split():
        if not a.startswith("127.") and ":" not in a:
            addrs.add(a)
    return sorted(addrs)


def verify(server_name, addresses):
    ok = True
    for addr in ["127.0.0.1"] + addresses:
        st, loc, srv, _ = probe(f"http://{addr}{PROBE_PATH}", server_name)
        good = st in ("301", "308") and loc.startswith(f"https://{server_name}{PROBE_PATH}")
        ok &= good
        print(f"  verify http://{addr}{PROBE_PATH} (Host: {server_name}) -> {st} {loc or '(no Location)'} server={srv or '?'}   [{'OK' if good else 'FAIL'}]")
    st, _, srv, _ = probe(f"https://{server_name}{PROBE_PATH}", server_name, resolve=f"{server_name}:443:127.0.0.1")
    good = st[:1] in ("2", "3", "4")
    ok &= good
    print(f"  verify https://{server_name}{PROBE_PATH} via loopback -> {st} server={srv or '?'}   [{'OK' if good else 'FAIL'}]  (the app answers 200 with a JSON code today)")
    return ok


# ---------------------------------------------------------------- planning

def plan_for(block, server_name):
    """(insertion_offset, insertion_text, note) for an editable effective block, or None for a new file."""
    text = block.text
    if block.redirects:
        return "already", None, f"{block.where()}: already redirects to https — nothing to do"
    if block.name_match is None or server_name.lower() not in [n.lower() for n in block.names]:
        return "newfile", None, f"{block.where()}: effective block is a catch-all/other-name block (server_name {' '.join(block.names)}) — a dedicated exact-name :80 block will be added instead"
    eol = text.find("\n", block.bo + block.name_match.end())
    at = eol if eol != -1 else block.bo + block.name_match.end()
    indent = re.match(r"[ \t]*", text[text.rfind("\n", 0, block.bo + block.name_match.start()) + 1:]).group(0)
    if 443 in block.ports():
        ins = f"\n{indent}# Stage 0A gate 12: plain HTTP must not serve the API\n{indent}if ($scheme = http) {{ {REDIRECT} }}"
        return "edit", (at, ins), f"{block.where()}: combined :80/:443 block — scheme-conditional redirect"
    ins = f"\n{indent}# Stage 0A gate 12: plain HTTP must not serve the API\n{indent}{REDIRECT}"
    return "edit", (at, ins), f"{block.where()}: :80-only block — unconditional redirect"


def new_redirect_file(server_name):
    return (
        "# Stage 0A gate 12: plain HTTP for the API host answers only with a redirect.\n"
        "# Added by scripts/patch_nginx_http_redirect.py; the HTTPS server block is elsewhere and untouched.\n"
        "server {\n    listen 80;\n    listen [::]:80;\n"
        f"    server_name {server_name};\n    {REDIRECT}\n}}\n"
    )


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    server_name = args[0] if args else DEFAULT_SERVER_NAME
    testing = bool(os.environ.get("NGINX_TEST_DUMP"))
    if os.geteuid() != 0 and not testing and not dry_run:
        sys.exit("Must run as root (nginx config is not world-writable).")
    print(f"server_name: {server_name}   mode: {'DRY RUN (analysis only)' if dry_run else 'apply'}\n")

    # ---- 1. who answers :80 at all?
    if not testing:
        print("== listeners on :80 (ss -ltnp)")
        lines = listeners_on_80()
        for l in lines:
            print("  " + l)
        if lines and not any("nginx" in l for l in lines):
            sys.exit("Port 80 is not served by nginx on this host — an nginx edit cannot add the redirect. Nothing changed.")
        addrs = public_addresses()
        print(f"== host addresses: 127.0.0.1 {' '.join(addrs)}")
        print("== what the host answers today (Host: %s)" % server_name)
        for addr in ["127.0.0.1"] + addrs:
            st, loc, srv, _ = probe(f"http://{addr}{PROBE_PATH}", server_name)
            print(f"  http://{addr}{PROBE_PATH} -> {st} {loc or ''} server={srv or '?'}")
    else:
        addrs = [a for a in os.environ.get("NGINX_TEST_ADDRS", "").split() if a]

    # ---- 2. the effective block, by nginx's rules, per address the request can arrive on
    files = split_dump(nginx_dump())
    blocks = all_blocks(files)
    print(f"\n== {len(blocks)} server block(s) loaded from {len(files)} file(s); blocks that mention {server_name}:")
    for b in blocks:
        if server_name.lower() in [n.lower() for n in b.names]:
            ls = ["%s:%s%s%s" % (a, p, " ssl" if s_ else "", " default" if d else "") for a, p, s_, d in b.listens]
            print("  %s  listen=%s  redirects=%s proxy_pass=%s" % (b.where(), ls, b.redirects, b.proxies))

    decisions = {}
    for addr in ["127.0.0.1"] + addrs:
        blk, why, cands = select(blocks, 80, addr, server_name)
        decisions[addr] = blk
        print(f"\n== request to {addr}:80 with Host: {server_name} is handled by:")
        if blk is None:
            print(f"  NONE — {why}")
        else:
            print(f"  {blk.where()}  ({why})")
            print("     listen=%s server_name=%s redirects=%s" % (["%s:%s" % (a, p) for a, p, _, _ in blk.listens], " ".join(blk.names), blk.redirects))
    effective = [b for b in decisions.values() if b is not None]
    if not effective:
        sys.exit(f"\nNo server block handles {server_name} on :80 on any address. Nothing changed.")
    distinct = {b.where(): b for b in effective}
    if len(distinct) > 1:
        print("\nNOTE: different addresses are handled by different blocks; every one of them will be patched.")

    # ---- 3. plan
    edits_by_path, notes, need_newfile = {}, [], False
    for b in distinct.values():
        kind, edit, note = plan_for(b, server_name)
        notes.append(note)
        if kind == "edit":
            edits_by_path.setdefault(b.path, []).append(edit)
        elif kind == "newfile":
            need_newfile = True
    print("\n== plan")
    for n in notes:
        print("  " + n)
    if not edits_by_path and not need_newfile:
        print("\nNothing to change — the effective block already redirects. If the host still answers 200, something in front of nginx is serving :80.")
        return

    changed = []
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for path, edits in edits_by_path.items():
        original = open(path).read() if not testing else dict(files)[path]
        updated = original
        for at, ins in sorted(edits, key=lambda e: e[0], reverse=True):
            updated = updated[:at] + ins + updated[at:]
        print("\n" + "\n".join(difflib.unified_diff(original.splitlines(), updated.splitlines(),
                                                    fromfile=f"{path} (before)", tofile=f"{path} (after)", lineterm="", n=2)))
        if not dry_run and not testing:
            backup = f"{path}.bak-{stamp}"
            shutil.copy2(path, backup)
            with open(path, "w") as h:
                h.write(updated)
            changed.append((path, backup, False))
    if need_newfile:
        ref = next(b for b in blocks if 443 in b.ports() and server_name.lower() in [n.lower() for n in b.names]) if any(443 in b.ports() and server_name.lower() in [n.lower() for n in b.names] for b in blocks) else effective[0]
        new_path = os.path.join(os.path.dirname(ref.path), f"00-{server_name.replace('.', '-')}-http-redirect.conf")
        print(f"\n--- new file {new_path}\n{new_redirect_file(server_name)}")
        if not dry_run and not testing:
            if os.path.exists(new_path):
                sys.exit(f"{new_path} already exists — refusing to overwrite.")
            with open(new_path, "w") as h:
                h.write(new_redirect_file(server_name))
            changed.append((new_path, None, True))

    if dry_run or testing:
        print("\nDry run: no file written, nothing reloaded.")
        return

    # ---- 4. validate, reload, verify, or roll back
    def restore():
        for path, backup, created in changed:
            if created:
                os.remove(path)
            else:
                shutil.copy2(backup, path)

    print("\nValidating...")
    t = run(["nginx", "-t"])
    print(t.stderr or t.stdout)
    if t.returncode != 0:
        restore()
        sys.exit("nginx -t FAILED. Every file was restored; nothing reloaded.")
    r = run(["systemctl", "reload", "nginx"])
    if r.returncode != 0:
        restore()
        run(["systemctl", "reload", "nginx"])
        sys.exit(f"Reload failed, config restored:\n{r.stderr}")
    print("nginx reloaded. Verifying (loopback AND public address, real Host header)...")
    time.sleep(1)
    if not verify(server_name, addrs):
        restore()
        run(["systemctl", "reload", "nginx"])
        sys.exit("Verification FAILED: previous configuration restored and reloaded. See the analysis above for which block answered.")
    print("\nDone. Plain HTTP now redirects; HTTPS unchanged.")
    for path, backup, created in changed:
        print(f"  {'created' if created else 'edited'}: {path}" + (f"   backup: {backup}" if backup else ""))


if __name__ == "__main__":
    main()
