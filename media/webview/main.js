// ForgePilot agent panel. Plain DOM, no framework; all state comes from the extension.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /** Minimal markdown: fenced code, inline code, bold. Everything else is escaped text. */
  function md(text) {
    const parts = String(text).split(/```[^\n]*\n?/);
    return parts
      .map((p, i) =>
        i % 2 === 1
          ? `<pre>${esc(p)}</pre>`
          : esc(p)
              .replace(/`([^`\n]+)`/g, "<code>$1</code>")
              .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>"),
      )
      .join("");
  }

  const state = { models: [], serverUrl: "", running: false, mode: null, reviews: [], changes: [], activeModel: null };
  const runs = new Map(); // turnKey -> run view
  let currentRun = null;
  const toolEls = new Map(); // toolCallId -> {dot, body}
  const threads = new Map(); // threadId -> {el, text}

  // ---------- layout ----------
  const modelsEl = $("div", { class: "models" });
  const sessionBtn = $("button", { title: "Open this TrueForge session (turns and tool calls)", onclick: () => vscode.postMessage({ type: "openSession", mode: "agent" }) }, "Session ↗");
  const newBtn = $("button", { title: "Start a new TrueForge session", onclick: () => vscode.postMessage({ type: "newSession" }) }, "New");
  const scroll = $("div", { class: "scroll" });
  const reviewsEl = $("div");
  const changesEl = $("div");
  const input = $("textarea", { placeholder: "Ask ForgePilot to change the code…  (@ to mention a file or symbol, Enter to send, Shift+Enter for newline)" });
  const mentionBox = $("div", { class: "mentions", style: "display:none" });
  const sendBtn = $("button", { class: "primary", onclick: () => send() }, "Send");
  const hint = $("div", { class: "hint" }, "");
  const app = document.getElementById("app");
  app.append(
    $("div", { class: "topbar" }, modelsEl, sessionBtn, newBtn),
    scroll,
    $("div", { class: "composer" }, mentionBox, reviewsEl, input, $("div", { class: "row" }, hint, sendBtn)),
  );
  scroll.append(
    $(
      "div",
      { class: "empty" },
      $("b", {}, "ForgePilot"),
      " runs on TrueForge. Describe a change and it will find the relevant code, show which files it chose and why, and propose edits you review hunk by hunk.",
      $("br"),
      $("br"),
      "Inline edit: select code and press ",
      $("code", {}, "Cmd/Ctrl+Alt+K"),
      ". Cancel anytime with ",
      $("code", {}, "Cmd/Ctrl+Alt+Esc"),
      " or the Stop button.",
    ),
  );
  const changesWrap = $("details", { class: "card changes" }, $("summary", {}, "Applied changes"), changesEl);
  scroll.after(changesWrap);
  changesWrap.style.margin = "0 8px 8px";
  changesWrap.style.display = "none";

  function stick() {
    const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    if (near) requestAnimationFrame(() => (scroll.scrollTop = scroll.scrollHeight));
  }

  function renderModels() {
    modelsEl.replaceChildren();
    if (!state.models.length) {
      modelsEl.append($("span", {}, "No model chosen — run “ForgePilot: Choose Models”"));
      return;
    }
    state.models.forEach((m, i) => {
      if (i) modelsEl.append($("span", {}, "→"));
      const cls = ["chip", i === 0 ? "primary" : "", state.activeModel === m ? "active" : ""].join(" ");
      modelsEl.append($("span", { class: cls, title: i === 0 ? "primary" : `fallback ${i}` }, m));
    });
  }

  function setRunning(on) {
    state.running = on;
    sendBtn.textContent = on ? "Stop" : "Send";
    sendBtn.className = on ? "danger" : "primary";
    hint.textContent = on ? "Running… the editor stays usable. Stop cancels immediately; accepted changes stay, nothing is half-applied." : "";
  }

  // ---------- run rendering ----------
  function newRun(turnKey, mode, request) {
    scroll.querySelector(".empty")?.remove();
    const el = $("div", { class: "run" });
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.gap = "6px";
    el.append($("div", { class: "msg-user" }, mode === "inline" ? `✎ Inline edit: ${request}` : request.split("\n\n@symbol")[0]));
    scroll.append(el);
    const run = { el, mode, turnKey, t0: Date.now() };
    runs.set(turnKey, run);
    currentRun = run;
    threads.clear();
    stick();
    return run;
  }

  function threadBox(threadId) {
    if (threads.has(threadId)) return threads.get(threadId);
    const host = currentRun ? currentRun.el : scroll;
    let el;
    if (threadId === "main") el = host;
    else {
      el = $("div", { class: "thread" }, $("div", { class: "thread-title" }, `sub-agent ${threadId.slice(-6)}`));
      host.append(el);
    }
    const t = { el, text: null, buf: "" };
    threads.set(threadId, t);
    return t;
  }

  function appendText(threadId, delta) {
    const t = threadBox(threadId);
    if (!t.text) {
      t.text = $("div", { class: "assistant" });
      t.el.append(t.text);
      t.buf = "";
    }
    t.buf += delta;
    t.text.innerHTML = md(t.buf);
    stick();
  }

  function breakText(threadId) {
    const t = threads.get(threadId);
    if (t) t.text = null;
  }

  function shortArgs(name, json) {
    try {
      const a = JSON.parse(json || "{}");
      if (name === "read_file") return `${a.path}${a.start_line ? `:${a.start_line}-${a.end_line || ""}` : ""}`;
      if (name === "propose_edit") return `${a.path} (${(a.edits || []).length} edit${(a.edits || []).length === 1 ? "" : "s"})`;
      if (name === "propose_new_file") return a.path;
      if (name === "run_command") return a.command;
      if (name === "retrieve_context") return a.query;
      if (name === "search_code") return a.query;
      if (name === "find_symbol") return a.name;
      if (name === "declare_plan") return a.summary;
      if (name === "create_sub_agent") return a.title || a.name || a.task || "";
      return Object.values(a).filter((v) => typeof v === "string").join(" ").slice(0, 120);
    } catch {
      return "";
    }
  }

  function addTool(call) {
    const t = threadBox(call.threadId);
    breakText(call.threadId);
    const dot = $("span", { class: "dot run" });
    const body = $("div", { class: "body" });
    const el = $(
      "details",
      { class: "tool" },
      $("summary", {}, dot, $("span", { class: "name" }, call.name), $("span", { class: "args", title: shortArgs(call.name, call.argsJson) }, shortArgs(call.name, call.argsJson))),
      body,
    );
    t.el.append(el);
    toolEls.set(call.id, { dot, body, name: call.name });
    stick();
  }

  function toolResult(id, content) {
    const t = toolEls.get(id);
    if (!t) return;
    const err = /^\{"error"|User denied|Edit not applied|not been approved|Tool failed|does not exist|cancelled/i.test(content);
    t.dot.className = `dot ${err ? "err" : "ok"}`;
    t.body.replaceChildren($("pre", {}, content.length > 4000 ? content.slice(0, 4000) + "\n…" : content));
  }

  function notice(text, kind) {
    const host = currentRun ? currentRun.el : scroll;
    host.append($("div", { class: `notice ${kind || ""}` }, text));
    stick();
  }

  function contextCard(report, origin) {
    const host = currentRun ? currentRun.el : scroll;
    const pct = Math.min(100, Math.round((100 * report.used) / Math.max(1, report.budget)));
    const share = report.indexed.tokens ? ((100 * report.used) / report.indexed.tokens).toFixed(1) : "0";
    const rows = report.selected.map((s) => {
      const reasons = s.reasons || [];
      return $(
        "div",
        { class: "ctx-row" },
        $("span", { class: "path" }, $("button", { class: "link", onclick: () => vscode.postMessage({ type: "openFile", path: s.path, line: s.ranges[0]?.start }) }, s.path)),
        $("span", { class: "tok" }, `${s.tokens} tok${s.outlineOnly ? " · pointer" : ""}`),
        $("span", { class: "why" }, [...new Set(reasons.map((r) => r.signal))].map((sig) => $("span", { class: `badge ${sig}`, title: reasons.filter((r) => r.signal === sig).map((r) => r.detail).join("\n") }, sig))),
        $("span", { class: "why-text" }, reasons.slice(0, 2).map((r) => r.detail).join(" · ")),
      );
    });
    const excluded = report.excluded.length
      ? $("details", { class: "excluded" }, $("summary", {}, `${report.excluded.length} candidate(s) left out`), report.excluded.map((e) => $("div", {}, `${e.path} — ${e.reason}`)))
      : null;
    host.append(
      $(
        "div",
        { class: "card ctx" },
        $("h4", {}, origin === "auto" ? "Context · automatic" : "Context · retrieve_context", $("span", { class: "sub" }, `“${report.query.split("\n")[0].slice(0, 80)}”`)),
        $("div", { class: "budget", title: `${report.used} of ${report.budget} tokens` }, $("div", { style: `width:${pct}%` })),
        $("div", { class: "timing" }, `${report.used}/${report.budget} tokens · ${report.selected.length} files of ${report.indexed.files} indexed · ${share}% of the repo · ${report.ms} ms${report.lowConfidence ? " · LOW CONFIDENCE" : ""}`),
        rows,
        excluded,
      ),
    );
    stick();
  }

  function planCard(plan) {
    const host = currentRun ? currentRun.el : scroll;
    host.append(
      $(
        "div",
        { class: "card plan" },
        $("h4", {}, "Plan", $("span", { class: "sub" }, plan.summary)),
        $("ul", {}, plan.steps.map((s) => $("li", {}, $("button", { class: "link", onclick: () => vscode.postMessage({ type: "openFile", path: s.file }) }, s.file), ` — ${s.change}`))),
      ),
    );
    stick();
  }

  // ---------- reviews ----------
  function renderReviews() {
    reviewsEl.replaceChildren();
    const open = state.reviews.filter((r) => r.status === "reviewing");
    for (const r of open) {
      const pending = r.hunks.filter((h) => h.decision === "pending").length;
      const card = $(
        "div",
        { class: "card review" },
        $(
          "h4",
          {},
          `Review ${r.relPath}`,
          $("span", { class: "sub" }, `${pending} of ${r.hunks.length} pending`),
          $("span", { style: "flex:1" }),
          $("button", { onclick: () => vscode.postMessage({ type: "openReview", id: r.id }) }, "Open diff"),
          $("button", { class: "primary", onclick: () => vscode.postMessage({ type: "decideAll", id: r.id, decision: "accepted" }) }, "Accept rest"),
          $("button", { onclick: () => vscode.postMessage({ type: "decideAll", id: r.id, decision: "rejected" }) }, "Reject rest"),
        ),
      );
      card.style.maxHeight = "45vh";
      card.style.overflowY = "auto";
      for (const h of r.hunks) {
        const lines = [...h.removed.map((l) => `<span class="l-del">- ${esc(l)}</span>`), ...h.added.map((l) => `<span class="l-add">+ ${esc(l)}</span>`)].join("");
        const pre = $("pre");
        pre.innerHTML = lines + (h.more ? `\n… ${h.more} more line(s) — open the diff` : "");
        const btns =
          h.decision === "pending"
            ? [
                $("button", { class: "primary", onclick: () => vscode.postMessage({ type: "decide", id: r.id, hunkId: h.id, decision: "accepted" }) }, "Accept"),
                $("button", { onclick: () => vscode.postMessage({ type: "decide", id: r.id, hunkId: h.id, decision: "rejected" }) }, "Reject"),
              ]
            : [$("button", { onclick: () => vscode.postMessage({ type: "decide", id: r.id, hunkId: h.id, decision: "pending" }) }, h.decision === "accepted" ? "✓ accepted · undo" : "✗ rejected · undo")];
        card.append(
          $(
            "div",
            { class: `hunk ${h.decision}` },
            $("div", { class: "hunk-head" }, $("span", { class: "grow" }, `hunk ${h.id + 1} · line ${h.start}`), btns),
            h.warnings.map((w) => $("div", { class: "warn" }, `⚠ ${w}`)),
            pre,
          ),
        );
      }
      reviewsEl.append(card);
    }
  }

  function renderChanges() {
    changesEl.replaceChildren();
    changesWrap.style.display = state.changes.length ? "" : "none";
    const byTurn = new Map();
    for (const c of state.changes) {
      if (!byTurn.has(c.turnKey)) byTurn.set(c.turnKey, []);
      byTurn.get(c.turnKey).push(c);
    }
    for (const [turnKey, list] of [...byTurn.entries()].reverse()) {
      const active = list.some((c) => !c.undone);
      changesEl.append(
        $(
          "div",
          { class: "row" },
          $("b", {}, (list[0].source || "").slice(0, 70)),
          $("span", { style: "flex:1" }),
          active && list.length > 1 ? $("button", { onclick: () => vscode.postMessage({ type: "undoTurn", turnKey }) }, "Undo this run") : null,
        ),
      );
      for (const c of list) {
        changesEl.append(
          $(
            "div",
            { class: "row" },
            $("span", { class: `path ${c.undone ? "undone" : ""}` }, $("button", { class: "link", onclick: () => vscode.postMessage({ type: "openFile", path: c.relPath }) }, c.relPath)),
            c.hunks.map((h) =>
              h.undone
                ? $("span", { class: "badge" }, `h${h.id + 1} undone`)
                : $("button", { title: `Undo only hunk ${h.id + 1} (+${h.added}/-${h.removed})`, onclick: () => vscode.postMessage({ type: "undo", changeId: c.id, hunkIds: [h.id] }) }, `↶ h${h.id + 1}`),
            ),
            c.undone ? null : $("button", { onclick: () => vscode.postMessage({ type: "undo", changeId: c.id }) }, "Undo file"),
          ),
        );
      }
    }
  }

  // ---------- events from the extension ----------
  function onEvent(e) {
    switch (e.type) {
      case "run":
        if (e.phase === "start") {
          newRun(e.turnKey, e.mode, e.request);
          setRunning(true);
        } else {
          const run = runs.get(e.turnKey);
          const r = e.result;
          const secs = run ? ((Date.now() - run.t0) / 1000).toFixed(1) : "?";
          if (r.status === "done") notice(`Finished on ${r.model} in ${secs} s.`, "ok");
          else if (r.status === "cancelled") notice(`Cancelled${r.cancelLatencyMs !== undefined ? ` (stopped in ${r.cancelLatencyMs} ms)` : ""}. Nothing unreviewed was written; accepted changes stay and can be undone below.`, "warn");
          else notice(`Failed: ${r.error ? r.error.message : "unknown error"} No files were changed by the failed request.`, "err");
          setRunning(false);
          currentRun = null;
        }
        break;
      case "text":
        appendText(e.threadId, e.delta);
        break;
      case "tool":
        addTool(e.call);
        break;
      case "toolResult":
        toolResult(e.toolCallId, e.content);
        break;
      case "context":
        contextCard(e.report, e.origin);
        break;
      case "plan":
        planCard(e.plan);
        break;
      case "status": {
        const s = e.status;
        if (s.kind === "attempt") {
          state.activeModel = s.model;
          renderModels();
        } else if (s.kind === "retry") notice(`↻ ${s.message}`, "warn");
        else if (s.kind === "fallback") {
          state.activeModel = s.model;
          renderModels();
          notice(`⇄ ${s.failure ? s.failure.message + " " : ""}${s.message}`, "warn");
        } else if (s.kind === "continue") notice(`↪ ${s.message}`, "warn");
        else if (s.kind === "failed") notice(`✕ ${s.message}`, "err");
        break;
      }
      case "thread":
        if (e.done) notice(`sub-agent “${e.title}” ${e.ok ? "finished" : "failed"}`, e.ok ? "" : "err");
        else {
          const t = threadBox(e.threadId);
          const title = t.el.querySelector(".thread-title");
          if (title) title.textContent = `sub-agent · ${e.title}`;
        }
        break;
      case "compaction":
        notice(
          e.phase === "started"
            ? `⧉ TrueForge compaction: context reached ${e.contextTokens ?? "?"} tokens (threshold ${e.thresholdTokens ?? "?"}); summarizing older history…`
            : `⧉ Compaction finished in ${e.durationMs ?? "?"} ms.`,
          "",
        );
        break;
      case "session":
        state.activeModel = e.model;
        renderModels();
        break;
      case "applied":
        notice(`✓ ${e.summary.split("\n")[0]}`, "ok");
        break;
      case "log":
        notice(e.message, "warn");
        break;
    }
  }

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "event":
        onEvent(m.event);
        break;
      case "config":
        state.models = m.models;
        state.serverUrl = m.serverUrl;
        renderModels();
        break;
      case "reviews":
        state.reviews = m.items;
        renderReviews();
        break;
      case "changes":
        state.changes = m.items;
        renderChanges();
        break;
      case "commandRequest": {
        const host = currentRun ? currentRun.el : scroll;
        const card = $(
          "div",
          { class: "card cmd-req", id: `cmd-${m.reqId}` },
          $("h4", {}, "Allow terminal command?"),
          $("code", {}, m.command),
          $(
            "div",
            {},
            $("button", { class: "primary", onclick: () => vscode.postMessage({ type: "commandAnswer", reqId: m.reqId, ok: true }) }, "Run"),
            " ",
            $("button", { onclick: () => vscode.postMessage({ type: "commandAnswer", reqId: m.reqId, ok: false }) }, "Deny"),
          ),
        );
        host.append(card);
        stick();
        break;
      }
      case "commandResolved": {
        const card = document.getElementById(`cmd-${m.reqId}`);
        if (card) card.replaceChildren($("div", { class: "timing" }, m.ok ? "✓ command allowed" : "✗ command denied"));
        break;
      }
      case "mentionResults":
        showMentions(m.items);
        break;
      case "cleared":
        scroll.replaceChildren($("div", { class: "empty" }, "New TrueForge session started."));
        break;
    }
  });

  // ---------- composer with @-mentions ----------
  let mentionItems = [];
  let mentionSel = 0;
  let mentionStart = -1;

  function mentionQuery() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = before.match(/(^|\s)@([\w./:-]*)$/);
    if (!m) return null;
    return { start: pos - m[2].length - 1, query: m[2].replace(/^(file|symbol):/, "") };
  }

  function showMentions(items) {
    mentionItems = items;
    mentionSel = 0;
    if (!items.length || mentionStart < 0) {
      mentionBox.style.display = "none";
      return;
    }
    mentionBox.replaceChildren(
      ...items.map((it, i) =>
        $("div", { class: i === mentionSel ? "sel" : "", onmousedown: (ev) => { ev.preventDefault(); pickMention(i); } }, $("span", { class: "kind" }, it.kind), $("span", {}, it.label), $("span", { class: "detail" }, it.detail)),
      ),
    );
    mentionBox.style.display = "";
  }

  function pickMention(i) {
    const it = mentionItems[i];
    if (!it) return;
    const pos = input.selectionStart;
    input.value = input.value.slice(0, mentionStart) + it.insert + " " + input.value.slice(pos);
    const caret = mentionStart + it.insert.length + 1;
    input.setSelectionRange(caret, caret);
    mentionStart = -1;
    mentionBox.style.display = "none";
    input.focus();
  }

  input.addEventListener("input", () => {
    const q = mentionQuery();
    if (!q) {
      mentionStart = -1;
      mentionBox.style.display = "none";
      return;
    }
    mentionStart = q.start;
    vscode.postMessage({ type: "mention", query: q.query });
  });

  input.addEventListener("keydown", (ev) => {
    if (mentionBox.style.display !== "none" && mentionItems.length) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        mentionSel = (mentionSel + (ev.key === "ArrowDown" ? 1 : mentionItems.length - 1)) % mentionItems.length;
        [...mentionBox.children].forEach((c, i) => (c.className = i === mentionSel ? "sel" : ""));
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        pickMention(mentionSel);
        return;
      }
      if (ev.key === "Escape") {
        mentionStart = -1;
        mentionBox.style.display = "none";
        return;
      }
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });

  function send() {
    if (state.running) {
      vscode.postMessage({ type: "cancel" });
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    vscode.postMessage({ type: "send", text });
  }

  renderModels();
  vscode.postMessage({ type: "ready" });
})();
