# Images an agent's conversation gained since the last call: Claude Code (with its subagents), Codex or pi.
# Also what the agent posted with herdr-post-image: ~/.cache/agent-gallery/outbox/<terminal>/<ms>-<name>.<ext>.
# argv[1]: JSON {pid, argv, cwd, known: {path: offset}, terminal, since (ms), outbox_after, outbox_part: {name, offset}}.
# A posted image larger than CHUNK comes in pieces: each but the last carries part: {name, offset of the next}.
# Prints JSON {main, more, files: [{path, offset, reset, sub}], outbox: {after}, images: [{file, mime, who, at, w, ht, caption?, data}]}.
import base64
import datetime
import re
import glob
import hashlib
import json
import os
import subprocess
import sys

HOME = os.path.expanduser("~")
# Herdr's exec from another machine fails somewhere between 5.6 and 6.8 MB of output: stay well under.
BUDGET = 2 * 1024 * 1024
CHUNK = 1536 * 1024
OUTBOX_TTL = 7 * 24 * 3600 * 1000
OUTBOX_NAME = re.compile(r"^(\d{13})-[A-Za-z0-9._-]*\.(png|jpg|gif|webp)$")
MIMES = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
TOOL_TYPES = {"tool_result", "function_call_output", "custom_tool_call_output"}


def tree(root):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout
    kids = {}
    for row in out.splitlines():
        parts = row.split()
        if len(parts) == 2:
            kids.setdefault(int(parts[1]), []).append(int(parts[0]))
    pids, todo = [], [root]
    while todo:
        p = todo.pop()
        pids.append(p)
        todo.extend(kids.get(p, []))
    return pids


def open_jsonl(pids):
    if os.path.isdir("/proc"):
        for p in pids:
            for fd in glob.glob(f"/proc/{p}/fd/*"):
                try:
                    path = os.readlink(fd)
                except OSError:
                    continue
                if path.endswith(".jsonl"):
                    yield path
    elif pids:
        out = subprocess.run(["lsof", "-Fn", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout
        for row in out.splitlines():
            if row.startswith("n") and row.endswith(".jsonl"):
                yield row[1:]


def newest(pattern):
    files = glob.glob(pattern)
    return max(files, key=os.path.getmtime) if files else None


def find_transcript(pid, argv, cwd):
    pids = tree(pid) if pid else []
    for p in pids:
        try:
            with open(f"{HOME}/.claude/sessions/{p}.json") as f:
                sid = json.load(f)["sessionId"]
        except (OSError, ValueError, KeyError):
            continue
        hit = glob.glob(f"{HOME}/.claude/projects/*/{sid}.jsonl")
        if hit:
            return hit[0]
    for path in open_jsonl(pids):
        if "/.codex/sessions/" in path or "/.pi/agent/sessions/" in path or "/.claude/projects/" in path:
            return path
    if "--session" in argv and argv.index("--session") + 1 < len(argv):
        path = os.path.expanduser(argv[argv.index("--session") + 1])
        if os.path.isfile(path):
            return path
    # pi appends without keeping the file open.
    name = os.path.basename(argv[0]) if argv else ""
    if name == "pi" and cwd:
        return newest(f"{HOME}/.pi/agent/sessions/--{cwd.strip('/').replace('/', '-')}--/*.jsonl")
    return None


def subagents(main):
    out = []
    for path in sorted(glob.glob(main[:-len(".jsonl")] + "/subagents/*.jsonl")):
        sub = {"type": "Subagent", "description": ""}
        try:
            with open(path[:-len(".jsonl")] + ".meta.json") as f:
                meta = json.load(f)
            sub = {"type": str(meta.get("agentType") or "Subagent"), "description": str(meta.get("description") or "")}
        except (OSError, ValueError):
            pass
        out.append((path, sub))
    return out


def images(o, who):
    if isinstance(o, list):
        for v in o:
            yield from images(v, who)
        return
    if not isinstance(o, dict):
        return
    # Tool inputs and outputs can carry their own "type" that is an object, not a string.
    kind = o.get("type")
    if not isinstance(kind, str):
        kind = None
    role = o.get("role")
    if role == "user":
        who = "you"
    elif role in ("toolResult", "tool") or kind in TOOL_TYPES:
        who = "tool"
    if kind == "image":
        src = o.get("source")
        if isinstance(src, dict) and src.get("type") == "base64" and isinstance(src.get("data"), str):
            yield src.get("media_type") or "image/png", src["data"], who
            return
        if isinstance(o.get("data"), str):
            yield o.get("mimeType") or o.get("mime_type") or "image/png", o["data"], who
            return
    if kind == "input_image" and str(o.get("image_url", "")).startswith("data:"):
        head, _, data = o["image_url"].partition(",")
        yield head[5:].split(";")[0] or "image/png", data, who
        return
    for v in o.values():
        if isinstance(v, (dict, list)):
            yield from images(v, who)


def size(data):
    # PNG IHDR or a JPEG SOF marker, from the first bytes only.
    head = data[:262144]
    b = base64.b64decode(head + "=" * (-len(head) % 4), validate=False)
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")
    i = 2
    while b[:2] == b"\xff\xd8" and i + 9 < len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        marker = b[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(b[i + 7:i + 9], "big"), int.from_bytes(b[i + 5:i + 7], "big")
        i += 2 + int.from_bytes(b[i + 2:i + 4], "big")
    return None, None


def scan(path, offset, sub, found, seen, spent):
    try:
        end = os.path.getsize(path)
    except OSError:
        return None
    reset = end < offset
    if reset:
        offset = 0
    if end == offset:
        return {"path": path, "offset": offset, "reset": reset, "sub": sub}
    with open(path, "rb") as f:
        f.seek(offset)
        chunk = f.read(end - offset)
    # A line still being written is read next time.
    cut = chunk.rfind(b"\n") + 1
    pos = 0
    for raw in chunk[:cut].split(b"\n")[:-1]:
        if spent[0] >= BUDGET:
            return {"path": path, "offset": offset + pos, "reset": reset, "sub": sub, "more": True}
        pos += len(raw) + 1
        if b'"image' not in raw:
            continue
        try:
            d = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get("type") == "api-request-blob":
            continue
        start = "tool" if sub is None and d.get("type") not in ("user", "attachment") else "you"
        if isinstance(d.get("toolUseResult"), (dict, list)) or d.get("sourceToolUseID"):
            start = "tool"
        for mime, data, who in images(d, start):
            h = hashlib.sha1(data.encode()).hexdigest()
            if h in seen:
                continue
            seen.add(h)
            spent[0] += len(data)
            w, ht = size(data)
            found.append({"file": path, "mime": mime, "who": "sub" if sub else who, "at": d.get("timestamp"),
                          "w": w, "ht": ht, "data": data})
    return {"path": path, "offset": offset + cut, "reset": reset, "sub": sub}


def header_size(path):
    try:
        with open(path, "rb") as f:
            return size(base64.b64encode(f.read(65536)).decode())
    except OSError:
        return None, None


def outbox(terminal, after, since, part, found, spent):
    if not terminal or "/" in terminal or ".." in terminal:
        return {"after": after, "more": False}
    root = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "agent-gallery", "outbox", terminal)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return {"after": after, "more": False}
    old = int(datetime.datetime.now().timestamp() * 1000) - OUTBOX_TTL
    for name in names:
        m = re.match(r"^(\d{13})-", name)
        if m and int(m.group(1)) < old:
            try:
                os.remove(os.path.join(root, name))
            except OSError:
                pass
    for name in names:
        m = OUTBOX_NAME.match(name)
        if not m or (after and name <= after) or int(m.group(1)) < max(old, since):
            continue
        if spent[0] >= BUDGET:
            return {"after": after, "more": True}
        path = os.path.join(root, name)
        start = int(part.get("offset") or 0) if isinstance(part, dict) and part.get("name") == name else 0
        try:
            total = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(start)
                raw = f.read(CHUNK)
        except OSError:
            continue
        data = base64.b64encode(raw).decode()
        spent[0] += len(data)
        end = start + len(raw)
        item = {"file": path, "mime": MIMES[m.group(2)], "who": "agent", "data": data, "start": start}
        if end < total:
            # Too big for one call: the rest comes in the next ones.
            item["part"] = {"name": name, "offset": end}
            found.append(item)
            return {"after": after, "more": True}
        caption = None
        try:
            with open(path.rsplit(".", 1)[0] + ".txt", encoding="utf-8", errors="replace") as f:
                caption = f.read(500).strip() or None
        except OSError:
            pass
        w, ht = header_size(path)
        at = datetime.datetime.fromtimestamp(int(m.group(1)) / 1000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        item.update({"at": at, "w": w, "ht": ht, "caption": caption})
        found.append(item)
        after = name
    return {"after": after, "more": False}


def main():
    req = json.loads(sys.argv[1])
    known = req.get("known") or {}
    path = find_transcript(req.get("pid"), req.get("argv") or [], req.get("cwd"))
    files, found, seen, spent = [], [], set(), [0]
    if path:
        todo = [(path, None)]
        if "/.claude/projects/" in path:
            todo += subagents(path)
        for p, sub in todo:
            r = scan(p, int(known.get(p) or 0), sub, found, seen, spent)
            if r:
                files.append(r)
    box = outbox(req.get("terminal"), req.get("outbox_after"), int(req.get("since") or 0), req.get("outbox_part"), found, spent)
    more = any(f.get("more") for f in files) or box["more"]
    json.dump({"main": path, "more": more, "files": files, "outbox": {"after": box["after"]}, "images": found}, sys.stdout)


if __name__ == "__main__":
    main()
