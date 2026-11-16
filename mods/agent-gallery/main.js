// Images in agents' conversations (Claude Code with its subagents, Codex, pi), here or on another
// machine. As a side panel: a grid or list of thumbnails. Opened with props.viewer: one image large.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, focused, agents, theme, props, openOverlay, closeOverlay, readTextFile, appHome, notify, layout, run, window, nextCommand } from "herdr";
import { writeFile, readFile, mkdir, readdir, unlink, exists } from "fs/promises";
import { createHash } from "crypto";

const MOD = "agent-gallery";
const TTL = 7 * 24 * 3600 * 1000;
const POLL = 4000;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const WHO = { you: "Pasted", tool: "Tool", sub: "Subagent", agent: "Agent" };
const FILTERS = [["all", "All"], ["you", "Pasted"], ["tool", "Tool"], ["sub", "Sub"], ["agent", "Agent"]];
const SIZES = [72, 100, 140, 190, 260, 340];
const GAP = 10;
// Cached pictures and index.json, in the app's own data folder: images load only from paths under the app folder,
// fs writes must resolve under it (a mod folder linked in from elsewhere doesn't), and it is outside the mod's hot reload.
const CACHE = `data/${MOD}/cache`;
const cacheDir = () => `${appHome()}/${CACHE}`;
const indexFile = () => `${cacheDir()}/index.json`;
// Copy and Preview use macOS tools.
const mac = () => window()?.platform === "macos";
const icon = (name) => svg(`mods/${MOD}/${name}.svg`);
const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
// Agent programs that can run without reporting a status, e.g. a Claude Code session moved to a background job.
const PROGRAMS = new Set(["claude", "codex", "pi"]);
// Where those terminals are ("space / tab"), since agents() doesn't list them.
const wheres = {};
function joinBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
function when(at) {
  const d = at ? new Date(at) : null;
  if (!d || isNaN(d)) return "";
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}
const kb = (n) => (!n ? "" : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const dims = (im) => (im.w && im.ht ? `${im.w}×${im.ht}` : "");
// The picture scaled to fit a box, never above its own size; host images fill and crop otherwise.
function fitted(im, boxW, boxH, grow = 1) {
  if (!im.w || !im.ht || boxW <= 0 || boxH <= 0) return image(im.src).size_full();
  const s = Math.min(boxW / im.w, boxH / im.ht, grow);
  return image(im.src).w(Math.max(1, Math.floor(im.w * s))).h(Math.max(1, Math.floor(im.ht * s))).flex_none();
}
const whoLabel = (im) =>
  im.who === "sub" ? im.sub?.description || im.sub?.type || WHO.sub
  : im.who === "agent" ? im.caption || WHO.agent
  : WHO[im.who] ?? im.who;

function agentName(address) {
  const a = agents().find((x) => x.address === address);
  const m = machineOf(address);
  const tab = a?.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : null;
  const name = a ? [a.space_name, tab].filter(Boolean).join(" / ") || a.title || address : wheres[address] || address;
  return m ? `${name} · ${m}` : name;
}

// Whether this mod's block is on screen: no hidden ancestor, the active child of every stack.
function shown(node, ok = true) {
  if (!node) return undefined;
  if (node.hidden) ok = false;
  if (node.content?.mod === MOD) return ok;
  const kids = node.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    const active = node.type !== "stack" || (node.active ? node.active === kids[i].id : i === 0);
    const r = shown(kids[i], ok && active);
    if (r !== undefined) return r;
  }
  return undefined;
}

async function copyImage(path) {
  if (!path.endsWith(".png")) {
    const png = path.replace(/\.[a-z]+$/, ".copy.png");
    if (!(await exists(png))) await exec("sips", ["-s", "format", "png", path, "--out", png]);
    path = png;
  }
  const r = await exec("osascript", ["-e", "on run argv", "-e", "set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)", "-e", "end run", path]);
  if (r.code !== 0) notify({ title: "Couldn't copy the image", body: r.stderr.trim(), level: "error" });
  return r.code === 0;
}

const openInPreview = (path) => exec("open", ["-a", "Preview", path]);
const revealInFinder = (path) => exec("open", ["-R", path]);

// A press on a control is not a drag of the window around it.
function control(el, onClick) {
  return el
    .cursor_pointer()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(cx, e);
    });
}

function iconButton(t, id, name, onClick, tip, on = false) {
  return control(
    h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(6)
      .bg(on ? t.selected : t.chrome)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .child(icon(name).size(14)),
    onClick,
  );
}

export default class AgentGallery extends View {
  init(_p, cx) {
    this.h = cx.focus_handle();
    this.copied = null;
    const viewer = props()?.viewer;
    if (viewer) return this.initViewer(viewer);
    this.target = null;
    this.state = {};
    this.index = { t: {}, byTerminal: {}, byOutbox: {} };
    this.files = new Set();
    // Posted images still arriving in pieces, by outbox key.
    this.partial = {};
    this.ready = false;
    this.busy = false;
    this.again = false;
    this.hover = null;
    this.width = 0;
    const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
    this.filter = pref("filter", "all");
    this.all = pref("all", false);
    this.view = pref("view", "grid");
    this.zoom = Math.min(SIZES.length - 1, Math.max(0, pref("zoom", 2)));
    cx.spawn(async (cx) => {
      try {
        await this.start();
      } catch (e) {
        // Without the cache nothing can load; say why instead of looking for images forever.
        this.startError = String(e?.message ?? e).replace(/^Error: /, "") || `Couldn't create ${CACHE}.`;
        cx.notify();
        return;
      }
      this.ready = true;
      if (this.visible()) this.load(cx);
      cx.notify();
    });
    cx.timer.every(POLL, (cx) => { if (this.ready && this.visible()) this.load(cx); });
    // Key commands: agent-gallery.view (newest image in the viewer), .zoom-in, .zoom-out, .grid, .list.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "view") {
          const list = this.filtered();
          if (list.length) this.openViewer(list, 0);
        } else if (c === "zoom-in") this.save("zoom", Math.min(SIZES.length - 1, this.zoom + 1));
        else if (c === "zoom-out") this.save("zoom", Math.max(0, this.zoom - 1));
        else if (c === "grid" || c === "list") this.save("view", c);
        cx.notify();
      }
    });
  }

  filtered() {
    return this.items().filter((im) => this.filter === "all" || im.who === this.filter);
  }

  save(k, v) {
    this[k] = v;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }

  visible() {
    return shown(layout()) ?? true;
  }

  // Reads the index and drops what nobody looked at for a week.
  async start() {
    await mkdir(cacheDir(), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(indexFile(), "utf8"));
      if (saved?.t && saved?.byTerminal) this.index = { byOutbox: {}, ...saved };
    } catch {}
    this.script = await readTextFile(`${appHome()}/mods/${MOD}/extract.py`);
    const cutoff = Date.now() - TTL;
    for (const [k, e] of Object.entries(this.index.t)) if (!(e.seen > cutoff)) delete this.index.t[k];
    for (const map of [this.index.byTerminal, this.index.byOutbox])
      for (const [a, k] of Object.entries(map)) if (!this.index.t[k]) delete map[a];
    const keep = new Set();
    for (const e of Object.values(this.index.t)) for (const im of e.items) keep.add(im.h);
    for (const name of await readdir(cacheDir())) {
      if (name === "index.json") continue;
      if (keep.has(name.split(".")[0])) this.files.add(name);
      else await unlink(`${cacheDir()}/${name}`).catch(() => {});
    }
    await this.persist();
  }

  async persist() {
    await writeFile(indexFile(), JSON.stringify(this.index));
  }

  targets() {
    if (this.all) return agents().map((a) => a.address);
    return this.target ? [this.target] : [];
  }

  load(cx) {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const target of this.targets()) {
        const s = (this.state[target] ??= {});
        try {
          changed = (await this.fetch(target)) || changed;
          s.error = null;
        } catch (e) {
          s.error = String(e?.message ?? e).replace(/^Error: /, "") || "The transfer from this agent's machine failed.";
        }
        s.loaded = true;
        cx.notify();
      }
      if (changed) await this.persist().catch(() => {});
      this.busy = false;
      if (this.again) { this.again = false; this.load(cx); }
    });
  }

  // Reads what the agent's transcripts gained since last time. True when the index changed.
  async fetch(target) {
    const t = JSON.parse((await hc(["get", target, "--json"])).stdout);
    const fg = t.foreground ?? {};
    const machine = machineOf(target);
    const terminal = target.split("/").pop();
    const before = this.index.byTerminal[target];
    const okey = `${machine ?? ""}:outbox:${terminal}:${t.created_ms ?? 0}`;
    const known = {};
    for (const [path, f] of Object.entries(this.index.t[before]?.files ?? {})) known[path] = f.offset;
    const req = JSON.stringify({
      pid: fg.pid ?? t.pid, argv: fg.argv ?? t.argv ?? [], cwd: fg.cwd ?? t.cwd, known,
      terminal, since: t.created_ms ?? 0, outbox_after: this.index.t[okey]?.after ?? null,
      outbox_part: this.partial[okey] ? { name: this.partial[okey].name, offset: this.partial[okey].offset } : null,
    });
    // Through sh: a remote core's own PATH may not reach python3.
    const r = await exec("sh", ["-c", 'python3 -c "$1" "$2"', "sh", this.script, req], { on: machine, timeout: 120000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    const out = JSON.parse(r.stdout);
    const now = Date.now();
    let changed = false;
    const entry = (key) => {
      const e = (this.index.t[key] ??= { files: {}, items: [], seen: 0 });
      if (now - e.seen > 3600 * 1000) changed = true;
      e.seen = now;
      return e;
    };

    const box = entry(okey);
    if (this.index.byOutbox[target] !== okey) changed = true;
    this.index.byOutbox[target] = okey;
    if (out.outbox?.after && out.outbox.after !== box.after) { box.after = out.outbox.after; changed = true; }

    let e = null;
    if (out.main) {
      const key = `${machine ?? ""}:${out.main}`;
      if (before !== key) changed = true;
      this.index.byTerminal[target] = key;
      e = entry(key);
      for (const f of out.files) {
        if (f.reset) e.items = e.items.filter((im) => im.file !== f.path);
        if (e.files[f.path]?.offset !== f.offset) changed = true;
        e.files[f.path] = { offset: f.offset, sub: f.sub ?? null };
      }
    } else delete this.index.byTerminal[target];

    for (const im of out.images) {
      const posted = im.who === "agent";
      const into = posted ? box : e;
      if (!into) continue;
      let bytes = Buffer.from(String(im.data), "base64");
      if (posted && (im.part || im.start > 0)) {
        const p = this.partial[okey];
        if (im.part) {
          const chunks = im.start > 0 && p?.name === im.part.name ? p.chunks : [];
          this.partial[okey] = { name: im.part.name, offset: im.part.offset, chunks: [...chunks, bytes] };
          continue;
        }
        delete this.partial[okey];
        if (!p || !im.file.endsWith(`/${p.name}`)) continue;
        bytes = joinBytes([...p.chunks, bytes]);
      }
      const h = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
      if (into.items.some((x) => (posted ? x.file === im.file : x.h === h))) continue;
      const ext = EXT[im.mime] ?? "png";
      const name = `${h}.${ext}`;
      if (!this.files.has(name)) {
        await writeFile(`${cacheDir()}/${name}`, bytes);
        this.files.add(name);
      }
      const sub = posted ? null : e.files[im.file]?.sub ?? null;
      into.items.push({
        h, ext, file: im.file, bytes: bytes.length,
        who: posted ? "agent" : sub ? "sub" : im.who === "you" ? "you" : "tool",
        sub: sub && { type: String(sub.type ?? ""), description: String(sub.description ?? "") },
        caption: posted && typeof im.caption === "string" ? im.caption.slice(0, 500) : null,
        at: typeof im.at === "string" ? im.at : null, w: num(im.w), ht: num(im.ht),
      });
      changed = true;
    }
    if (out.more) this.again = true;
    if (!out.main && !box.items.length) throw new Error("Couldn't find this agent's conversation.");
    return changed;
  }

  // What the panel shows, newest first, one card per picture.
  items() {
    const out = [], seen = new Set();
    for (const target of this.targets()) {
      const own = [this.index.t[this.index.byTerminal[target]], this.index.t[this.index.byOutbox[target]]];
      for (const im of own.flatMap((e) => e?.items ?? [])) {
        const id = im.who === "agent" ? `${im.h}:${im.file}` : im.h;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...im, key: id, src: `${CACHE}/${im.h}.${im.ext}`, path: `${cacheDir()}/${im.h}.${im.ext}`, agent: target });
      }
    }
    return out.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  }

  follow(cx) {
    const f = focused()?.terminal;
    if (!f || f === this.target) return;
    if (agents().some((a) => a.address === f)) return this.retarget(f, cx);
    // Not an agent to Herdr: once per focus, look at what runs there.
    if (f === this.probed) return;
    this.probed = f;
    cx.spawn(async (cx) => {
      try {
        const t = JSON.parse((await hc(["get", f, "--json"])).stdout);
        const argv = t.foreground?.argv ?? [];
        if (!argv.slice(0, 2).some((a) => PROGRAMS.has(String(a).split("/").pop()))) return;
        if (typeof t.labels?.where === "string") wheres[f] = t.labels.where;
        if (focused()?.terminal === f) { this.retarget(f, cx); cx.notify(); }
      } catch {}
    });
  }

  retarget(f, cx) {
    this.target = f;
    this.probed = null;
    this.hover = null;
    if (this.ready && !this.all) this.load(cx);
  }

  openViewer(list, i) {
    openOverlay({
      mod: MOD, kind: "dialog", width: 0.86, height: 0.9,
      props: {
        viewer: {
          index: i,
          items: list.map((im) => ({
            src: im.src, path: im.path, who: im.who, label: whoLabel(im), at: im.at, w: im.w, ht: im.ht, bytes: im.bytes,
            agent: this.all ? agentName(im.agent) : null,
          })),
        },
      },
    });
  }

  copy(path, key, cx) {
    cx.spawn(async (cx) => {
      if (!(await copyImage(path))) return;
      this.copied = key;
      cx.notify();
      cx.timer.after(1200, (cx) => {
        if (this.copied === key) this.copied = null;
        cx.notify();
      });
    });
  }

  copyIcon(t, key) {
    const done = this.copied === key;
    return icon(done ? "check" : "copy").size(13).when(done, (el) => el.text_color(t.working));
  }

  header(t, all) {
    const count = (f) => all.filter((im) => f === "all" || im.who === f).length;
    const subtitle = this.all ? `${agents().length} agents` : this.target ? agentName(this.target) : "";
    const segment = ([f, label]) => {
      const on = this.filter === f;
      return control(
        h_flex().id(`ai-f-${f}`).h(22).px(7).gap(5).items_center().rounded(5).text_size(12)
          .when(on, (el) => el.bg(t.surface).shadow_sm())
          .text_color(on ? t.foreground : t.muted)
          .hover((s) => s.text_color(t.foreground))
          .child(label)
          .child(div().text_color(t.dim).text_size(11).child(String(count(f)))),
        (cx) => { this.save("filter", f); this.hover = null; cx.notify(); },
      );
    };
    return v_flex().flex_none().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().h(38).pl(12).pr(8).gap(8).items_center()
        .child(icon("image").size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().font_semibold().text_size(13).child("Images"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(subtitle))
        .child(iconButton(t, "ai-all", "users", (cx) => { this.save("all", !this.all); this.hover = null; this.load(cx); cx.notify(); },
          this.all ? "Showing all agents" : "Show all agents", this.all))
        .child(iconButton(t, "ai-view", this.view === "grid" ? "list" : "layout-grid",
          (cx) => { this.save("view", this.view === "grid" ? "list" : "grid"); cx.notify(); },
          this.view === "grid" ? "List" : "Grid")))
      .child(h_flex().h(34).px(8).gap(6).items_center()
        .child(h_flex().flex_none().p(2).gap(1).rounded(7).bg(t.raised).children(FILTERS.map(segment)))
        .child(div().flex_1())
        .when(this.view === "grid", (el) => el
          .child(iconButton(t, "ai-zoom-out", "minus", (cx) => { this.save("zoom", Math.max(0, this.zoom - 1)); cx.notify(); }, "Smaller"))
          .child(iconButton(t, "ai-zoom-in", "plus", (cx) => { this.save("zoom", Math.min(SIZES.length - 1, this.zoom + 1)); cx.notify(); }, "Larger"))));
  }

  meta(t, im) {
    return h_flex().min_w(0).gap(6).items_center().text_size(11)
      .child(div().min_w(0).truncate().text_color(im.who === "you" ? t.accent : t.muted).child(whoLabel(im)))
      .child(div().flex_1())
      .child(div().flex_none().text_color(t.dim).child(when(im.at)));
  }

  agentLink(t, im) {
    return control(
      div().id(`ai-ag-${im.key}`).min_w(0).truncate().text_size(11).text_color(t.dim)
        .hover((s) => s.text_color(t.foreground)).tooltip("Go to this agent").child(agentName(im.agent)),
      () => run("agent.focus", { terminal: im.agent }),
    );
  }

  grid(t, list) {
    const inner = Math.max(0, this.width - 2 * 12);
    const size = SIZES[this.zoom];
    const cols = Math.max(1, Math.floor((inner + GAP) / (size + GAP)));
    const w = Math.max(40, Math.floor((inner - GAP * (cols - 1)) / cols));
    const thumbH = Math.round(w * 0.72);
    const captions = w >= 110;
    const card = (im, i) => {
      const hovered = this.hover === im.key;
      return control(
        v_flex().id(`ai-${im.key}`).w(w).gap(4)
          .on_hover((inside, cx) => {
            if (inside) this.hover = im.key;
            else if (this.hover === im.key) this.hover = null;
            cx.notify();
          })
          .when(!captions, (el) => el.tooltip(`${whoLabel(im)} · ${when(im.at)}`))
          .child(h_flex().relative().h(thumbH).items_center().justify_center().rounded(6).overflow_hidden().border(1)
            .border_color(hovered ? t.accent : t.border).bg(t.canvas)
            .child(fitted(im, w - 2, thumbH - 2, 4))
            .when(mac() && (hovered || this.copied === im.key), (el) => el.child(control(
              h_flex().id(`ai-qc-${im.key}`).absolute().top(4).right(4).size(24).items_center().justify_center()
                .rounded(5).bg(t.popover).border(1).border_color(t.border).shadow_sm().text_color(t.foreground)
                .hover((s) => s.bg(t.hover)).tooltip("Copy image")
                .child(this.copyIcon(t, im.key)),
              (cx) => this.copy(im.path, im.key, cx)))))
          .when(captions, (el) => el.child(v_flex().px(1).gap(1).child(this.meta(t, im))
            .when(this.all, (el) => el.child(this.agentLink(t, im))))),
        () => this.openViewer(list, i),
      );
    };
    return v_flex().id("ai-grid").flex_1().min_h(0).overflow_y_scrollbar().p(12)
      .child(h_flex().flex_wrap().gap(GAP).children(list.map(card)));
  }

  rows(t, list) {
    const row = (im, i) => control(
      h_flex().id(`ai-r-${im.key}`).h(54).px(10).gap(10).items_center().rounded(6)
        .hover((s) => s.bg(t.hover))
        .on_hover((inside, cx) => {
          if (inside) this.hover = im.key;
          else if (this.hover === im.key) this.hover = null;
          cx.notify();
        })
        .child(h_flex().w(64).h(42).flex_none().items_center().justify_center().rounded(4).overflow_hidden().border(1).border_color(t.border).bg(t.canvas)
          .child(fitted(im, 62, 40, 4)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(this.meta(t, im))
          .child(h_flex().min_w(0).gap(6).text_size(11).text_color(t.dim)
            .when(this.all, (el) => el.child(this.agentLink(t, im)))
            .child(div().flex_none().child([dims(im), kb(im.bytes)].filter(Boolean).join(" · ")))))
        .child(div().w(26).flex_none().when(mac() && (this.hover === im.key || this.copied === im.key), (el) => el.child(
          iconButton(t, `ai-rc-${im.key}`, this.copied === im.key ? "check" : "copy", (cx) => this.copy(im.path, im.key, cx), "Copy image")))),
      () => this.openViewer(list, i),
    );
    return v_flex().id("ai-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1).children(list.map(row));
  }

  render(cx) {
    const t = theme();
    if (this.v) return this.renderViewer(t);
    this.follow(cx);
    const vis = this.visible();
    if (vis && !this.wasVisible && this.ready) this.load(cx);
    this.wasVisible = vis;

    const all = this.items();
    const list = this.filtered();
    const s = this.all ? null : this.state[this.target];
    const errors = this.targets().map((a) => this.state[a]?.error).filter(Boolean);
    const empty = (title, hint) =>
      v_flex().flex_1().gap(8).px(24).items_center().justify_center()
        .child(icon("image").size(22).text_color(t.dim))
        .child(div().text_size(13).text_color(t.muted).child(title))
        .when(Boolean(hint), (el) => el.child(div().text_size(12).text_color(t.dim).child(hint)));
    let body;
    if (this.startError) body = empty("Couldn't start the Images panel", this.startError);
    else if (!this.all && !this.target) body = empty("No agent in focus", "Click an agent's terminal; this panel follows it.");
    else if (!list.length && s?.error) body = empty("Couldn't read this agent's images", s.error);
    else if (!list.length && !this.all && !s?.loaded) body = empty("Looking for images…");
    else if (!list.length) body = empty(this.filter === "all" ? "No images yet" : `No ${WHO[this.filter].toLowerCase()} images`,
      "Paste one into the agent with ⌘V and it shows up here.");
    else body = this.view === "list" ? this.rows(t, list) : this.grid(t, list);

    return v_flex().id("ai-root").size_full().bg(t.surface).text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); }
      })
      .child(this.header(t, all))
      .child(body)
      .when(list.length > 0 && errors.length > 0, (el) => el.child(
        div().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate()
          .child(this.all ? `${errors.length} agent${errors.length > 1 ? "s" : ""} couldn't be read` : `Couldn't refresh: ${errors[0]}`)));
  }

  // The viewer: one picture large, ‹ › through the list it was opened from.

  initViewer(v) {
    this.v = v;
    this.vw = 0;
    this.vh = 0;
    this.i = Math.min(Math.max(0, v.index | 0), v.items.length - 1);
    this.h.focus();
  }

  step(by, cx) {
    const n = this.v.items.length;
    this.i = (this.i + by + n) % n;
    cx.notify();
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  renderViewer(t) {
    const im = this.v.items[this.i];
    const n = this.v.items.length;
    const key = `v-${this.i}`;
    const side = (id, name, by, tip) => control(
      h_flex().id(id).absolute().top_0().bottom_0().when(by < 0, (el) => el.left_0()).when(by > 0, (el) => el.right_0())
        .w(64).items_center().justify_center().text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .child(h_flex().size(36).rounded(18).items_center().justify_center().bg(t.popover).border(1).border_color(t.border)
          .shadow_sm().tooltip(tip).child(icon(name).size(18))),
      (cx) => this.step(by, cx),
    );
    const info = [im.label, im.agent, when(im.at), dims(im), kb(im.bytes)].filter(Boolean).join("  ·  ");
    return v_flex().id("ai-viewer").size_full().bg(t.surface).text_color(t.foreground)
      .track_focus(this.h)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.vw) > 1 || Math.abs(size.height - this.vh) > 1) { this.vw = size.width; this.vh = size.height; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") { cx.stop_propagation(); this.dismiss(); }
        else if (k === "left" || k === "right") { cx.stop_propagation(); this.step(k === "left" ? -1 : 1, cx); }
        else if (mac() && k === "cmd-c") { cx.stop_propagation(); this.copy(im.path, key, cx); }
        else if (mac() && (k === "space" || k === "cmd-o")) { cx.stop_propagation(); openInPreview(im.path); }
        else if (mac() && k === "cmd-shift-r") { cx.stop_propagation(); revealInFinder(im.path); }
      })
      .child(h_flex().h(44).pl(14).pr(8).gap(8).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(12).text_color(t.muted).child(`${this.i + 1} of ${n}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(info))
        .child(iconButton(t, "ai-path", "link", (cx) => cx.write_to_clipboard(im.path), "Copy file path"))
        .when(mac(), (el) => el.child(control(
          h_flex().id("ai-folder").h(28).px(10).gap(6).items_center().rounded(6).text_size(12)
            .bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)).tooltip("Show in Finder  ⌘⇧R")
            .child(icon("folder-open").size(13)).child("Open folder"),
          () => revealInFinder(im.path))))
        .when(mac(), (el) => el.child(control(
          h_flex().id("ai-preview").h(28).px(10).gap(6).items_center().rounded(6).text_size(12)
            .bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)).tooltip("Open in Preview  Space")
            .child(icon("external-link").size(13)).child("Preview"),
          () => openInPreview(im.path)))
        .child(control(
          h_flex().id("ai-copy").h(28).px(10).gap(6).items_center().rounded(6).text_size(12)
            .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)).tooltip("Copy image  ⌘C")
            .child(this.copyIcon(t, key)).child("Copy"),
          (cx) => this.copy(im.path, key, cx))))
        .child(iconButton(t, "ai-close", "x", () => this.dismiss(), "Close  Esc")))
      .child(div().id("ai-stage").relative().flex_1().min_h(0).bg(t.canvas)
        .child(h_flex().size_full().items_center().justify_center()
          .child(fitted(im, this.vw - 2 * 72, this.vh - 44 - 2 * 20, 2)))
        .when(n > 1, (el) => el
          .child(side("ai-prev", "chevron-left", -1, "Previous  ←"))
          .child(side("ai-next", "chevron-right", 1, "Next  →"))));
  }
}
