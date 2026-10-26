(function () {
  "use strict";

  // worklog.html is web-accessible so the launcher page can open it; never run
  // inside another site's frame (prevents click-jacking the Log time button).
  if (window.top !== window.self) {
    document.documentElement.textContent = "Open Daily Work Log directly from the Chrome toolbar.";
    return;
  }

  const DEFAULT_PROJECT = "WHIP";
  const TARGET_HOURS = 8;
  const LAST_PROJECT_KEY = "dwl.lastProject";
  const SESSION_KEY = "dwl.session";
  const MAX_TARGETS = 4;
  const PROJECT_COLORS = ["#2df08a", "#b36bff", "#29d3ff", "#ff8f2e", "#ff4fa3", "#ffd23f", "#4f8bff"];
  const CHEERS = ["Great shot! Keep going!", "Bullseye!", "Direct hit!", "Clean shot!", "Locked on target!"];
  // Rank by fraction of today's target, highest first.
  const RANKS = [
    { min: 1, icon: "🔥", title: "You're on fire!", text: "Daily target hit. Keep logging and level up!" },
    { min: 0.75, icon: "💥", title: "On a roll", text: "Almost at today's target." },
    { min: 0.5, icon: "🚀", title: "Locked in", text: "Halfway there. Stay on target." },
    { min: 0.001, icon: "⚡", title: "Warming up", text: "Good start. Keep the shots coming." },
    { min: 0, icon: "🎯", title: "Ready, aim…", text: "Pick a target and log your first shot." },
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    todayLabel: $("today-label"),
    user: $("user"),
    avatar: $("user-avatar"),
    userName: $("user-name"),
    banner: $("signin-banner"),
    openJira: $("open-jira"),
    reload: $("reload"),
    form: $("log-form"),
    projectWrap: $("project-wrap"),
    project: $("project"),
    storiesOnly: $("stories-only"),
    taskFilter: $("task-filter"),
    taskList: $("task-list"),
    taskCount: $("task-count"),
    hours: $("hours"),
    start: $("start"),
    note: $("note"),
    formError: $("form-error"),
    submit: $("submit"),
    refreshToday: $("refresh-today"),
    totalLabel: $("total-label"),
    targetLabel: $("target-label"),
    progress: $("progress"),
    progressFill: $("progress-fill"),
    progressPct: $("progress-pct"),
    rank: $("rank"),
    rankIcon: $("rank-icon"),
    rankTitle: $("rank-title"),
    rankText: $("rank-text"),
    hitCount: $("hit-count"),
    entries: $("entries"),
    toasts: $("toasts"),
    syncStatus: $("sync-status"),
    syncNow: $("sync-now"),
    weapons: $("weapons"),
    weaponArt: $("weapon-art"),
    targets: $("targets"),
    blaster: $("blaster"),
    muzzle: $("muzzle"),
    beam: $("beam"),
    lastShot: $("last-shot"),
    lastShotTitle: $("last-shot-title"),
    lastShotBody: $("last-shot-body"),
    sessionTime: $("session-time"),
    sessionPause: $("session-pause"),
    keysOpen: $("keys-open"),
    keysHelp: $("keys-help"),
    keysClose: $("keys-close"),
  };

  const state = {
    issues: [],
    selectedKey: null,
    issuesRequest: 0,
    entries: [],
    submitting: false,
    projects: [],
    recentKeys: [],
    arenaKeys: [],
    entriesLoaded: false,
    syncing: false,
  };

  // ---------- Utilities ----------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function formatHours(h) {
    const mins = Math.round(h * 60);
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    if (!hh) return `${mm}m`;
    return mm ? `${hh}h ${mm}m` : `${hh}h`;
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function issueUrl(key) { return `${Jira.BASE}/browse/${encodeURIComponent(key)}`; }

  function hash(s) {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h);
  }

  function projectColor(key) { return PROJECT_COLORS[hash(key) % PROJECT_COLORS.length]; }

  function projectName(key) {
    const p = state.projects.find((x) => x.key === key);
    return p ? p.name : key;
  }

  function sumHoursBy(keyOf) {
    const out = new Map();
    for (const e of state.entries) out.set(keyOf(e), (out.get(keyOf(e)) || 0) + e.hours);
    return out;
  }

  // Handles every failure the same way: signed-out -> banner; otherwise Jira's message in a toast.
  function handleError(err, context) {
    console.error(`[Daily Work Log] ${context}:`, err);
    if (err && err.auth) {
      showBanner();
      return;
    }
    toast(`${context}: ${err && err.message ? err.message : String(err)}`, "error");
  }

  function showBanner() {
    els.banner.hidden = false;
  }

  // ---------- Toasts ----------

  function toast(message, type = "info", timeout = type === "error" ? 8000 : 4000) {
    const close = el("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", text: "×" });
    const node = el("div", { class: `toast ${type}`, role: type === "error" ? "alert" : "status" },
      el("span", { class: "toast-msg", text: message }), close);
    const remove = () => node.remove();
    close.addEventListener("click", remove);
    els.toasts.append(node);
    if (timeout) setTimeout(remove, timeout);
  }

  // ---------- Header ----------

  function renderDate() {
    els.todayLabel.textContent = new Date().toLocaleDateString([], {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  }

  async function loadUser() {
    try {
      const me = await Jira.getMyself();
      els.userName.textContent = me.displayName;
      els.userName.classList.remove("skeleton-text");
      els.avatar.textContent = Jira.initials(me.displayName);
      els.avatar.classList.remove("skeleton");
      els.avatar.title = me.displayName;
    } catch (err) {
      els.userName.textContent = "Not signed in";
      els.userName.classList.remove("skeleton-text");
      els.avatar.textContent = "?";
      els.avatar.classList.remove("skeleton");
      handleError(err, "Couldn't load your profile");
    } finally {
      els.user.setAttribute("aria-busy", "false");
    }
  }

  // ---------- Session timer ----------

  // How long this tab has been open, minus paused time. Kept in sessionStorage so a reload doesn't reset it.
  const session = { elapsed: 0, since: Date.now(), paused: false };

  function sessionMs() { return session.elapsed + (session.paused ? 0 : Date.now() - session.since); }

  function saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (_) { /* storage unavailable */ }
  }

  function renderSession() {
    const s = Math.floor(sessionMs() / 1000);
    els.sessionTime.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }

  function renderSessionPaused() {
    els.sessionPause.setAttribute("aria-pressed", String(session.paused));
    els.sessionPause.setAttribute("aria-label", session.paused ? "Resume session timer" : "Pause session timer");
    els.sessionPause.title = session.paused ? "Resume" : "Pause";
    els.sessionPause.parentElement.classList.toggle("paused", session.paused);
  }

  function toggleSession() {
    if (session.paused) session.since = Date.now();
    else session.elapsed = sessionMs();
    session.paused = !session.paused;
    saveSession();
    renderSessionPaused();
    renderSession();
  }

  function startSession() {
    try { Object.assign(session, JSON.parse(sessionStorage.getItem(SESSION_KEY)) || {}); } catch (_) { /* fresh session */ }
    saveSession();
    renderSessionPaused();
    renderSession();
    setInterval(renderSession, 1000);
  }

  // ---------- Projects ----------

  function readLastProject() {
    try { return localStorage.getItem(LAST_PROJECT_KEY); } catch (_) { return null; }
  }

  function rememberProject(key) {
    try { localStorage.setItem(LAST_PROJECT_KEY, key); } catch (_) { /* storage unavailable */ }
    state.recentKeys = [key, ...state.recentKeys.filter((k) => k !== key)].slice(0, 5);
    renderProjectOptions(els.project.value);
    renderArena();
  }

  // Recent projects (last logged first) in their own group at the top, then everything A–Z.
  function renderProjectOptions(selected) {
    const byKey = new Map(state.projects.map((p) => [p.key, p]));
    const recent = state.recentKeys.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
    const option = (p) => el("option", { value: p.key, text: `${p.name} (${p.key})` });

    const groups = [];
    if (recent.length) groups.push(el("optgroup", { label: "Recently logged" }, ...recent.map(option)));
    groups.push(el("optgroup", { label: "All projects" }, ...state.projects.map(option)));
    els.project.replaceChildren(...groups);

    if (selected && byKey.has(selected)) els.project.value = selected;
    else if (recent.length) els.project.value = recent[0].key;
    else els.project.value = byKey.has(DEFAULT_PROJECT) ? DEFAULT_PROJECT : state.projects[0].key;
  }

  async function loadProjects() {
    try {
      // Recent projects are a nice-to-have; never let them block the project list.
      const [projects, recentFromJira] = await Promise.all([
        Jira.getProjects(),
        Jira.getRecentProjectKeys().catch((err) => {
          console.warn("[Daily Work Log] Couldn't load recent projects:", err);
          return [];
        }),
      ]);
      projects.sort((a, b) => a.name.localeCompare(b.name));
      state.projects = projects;

      if (!projects.length) {
        els.project.replaceChildren(el("option", { value: "", text: "No projects available" }));
        renderTaskEmpty("No projects", "You don't have access to any Jira projects.");
        renderArenaEmpty("No projects to shoot at");
        return;
      }

      // The project you last logged to from this page wins; then Jira's recent worklogs.
      const last = readLastProject();
      state.recentKeys = [...new Set([last, ...recentFromJira].filter(Boolean))].slice(0, 5);
      renderProjectOptions();
      renderArena();
      if (state.entriesLoaded) renderLastShot(); // now with project names
      els.project.disabled = false;
      loadIssues();
    } catch (err) {
      els.project.replaceChildren(el("option", { value: "", text: "Couldn't load projects" }));
      renderTaskEmpty("Tasks unavailable", "Projects couldn't be loaded.");
      renderArenaEmpty("Projects couldn't be loaded");
      handleError(err, "Couldn't load projects");
    } finally {
      els.projectWrap.setAttribute("aria-busy", "false");
    }
  }

  // ---------- Arena ----------

  // Targets and weapon cards show up to MAX_TARGETS projects. The set only changes when
  // a project outside it is picked, so nothing jumps around after each shot.
  function updateArenaKeys() {
    const valid = new Set(state.projects.map((p) => p.key));
    const current = els.project.value;
    let keys = state.arenaKeys.filter((k) => valid.has(k));
    if (!keys.length) {
      keys = [...new Set([current, ...state.recentKeys, ...state.projects.map((p) => p.key)])]
        .filter((k) => valid.has(k)).slice(0, MAX_TARGETS);
    }
    if (valid.has(current) && !keys.includes(current)) keys = [...keys.slice(0, MAX_TARGETS - 1), current];
    state.arenaKeys = keys;
  }

  function renderArenaPlaceholders() {
    els.targets.dataset.keys = "";
    els.targets.replaceChildren(...Array.from({ length: 3 }, () =>
      el("span", { class: "target placeholder" },
        el("span", { class: "target-body" }, el("span", { class: "target-board" }), el("span", { class: "target-stand" })))));
    els.weapons.replaceChildren(...Array.from({ length: MAX_TARGETS }, () =>
      el("span", { class: "weapon placeholder", "aria-hidden": "true" })));
  }

  function renderArenaEmpty(message) {
    els.targets.dataset.keys = "";
    els.targets.replaceChildren(el("span", { class: "targets-empty", text: message }));
    els.weapons.replaceChildren();
    aim();
  }

  function renderArena() {
    updateArenaKeys();
    if (!state.arenaKeys.length) return;
    const current = els.project.value;
    const today = sumHoursBy((e) => e.issueKey.split("-")[0]);
    const sub = (key) => (today.get(key) ? `${key} · ${formatHours(today.get(key))} today` : key);
    const initial = (key) => projectName(key).charAt(0).toUpperCase();

    // Rebuild only when the set changes, so a running hit animation isn't cut off.
    const sig = state.arenaKeys.join(",");
    if (els.targets.dataset.keys !== sig) {
      els.targets.dataset.keys = sig;
      els.targets.replaceChildren(...state.arenaKeys.map((key) =>
        el("button", { type: "button", class: "target", tabindex: "-1", style: `--c:${projectColor(key)}`, "data-key": key },
          el("span", { class: "target-body" },
            el("span", { class: "target-plate" },
              el("span", { class: "p-icon", text: initial(key) }),
              el("span", {}, el("b", { text: projectName(key) }), el("small"))),
            el("span", { class: "target-board" }),
            el("span", { class: "target-stand" })))));
      els.weapons.replaceChildren(...state.arenaKeys.map((key, i) =>
        el("button", { type: "button", class: "weapon", style: `--c:${projectColor(key)}`, "data-key": key, title: projectName(key), "aria-keyshortcuts": String(i + 1) },
          el("kbd", { class: "weapon-key", "aria-hidden": "true", text: String(i + 1) }),
          els.weaponArt.content.cloneNode(true),
          el("span", { class: "weapon-name", text: projectName(key) }),
          el("span", { class: "weapon-sub" }))));
    }

    for (const node of els.targets.children) {
      node.classList.toggle("is-active", node.dataset.key === current);
      node.querySelector("small").textContent = sub(node.dataset.key);
    }
    for (const node of els.weapons.children) {
      node.setAttribute("aria-pressed", String(node.dataset.key === current));
      node.querySelector(".weapon-sub").textContent = sub(node.dataset.key);
    }
    requestAnimationFrame(aim);
    setTimeout(aim, 400); // again once the active target has finished growing
  }

  function selectProject(key) {
    if (!key || els.project.disabled || els.project.value === key) return;
    els.project.value = key;
    els.project.dispatchEvent(new Event("change"));
  }

  function center(rect, origin) {
    return { x: rect.left + rect.width / 2 - origin.left, y: rect.top + rect.height / 2 - origin.top };
  }

  // Turn the blaster (pivoting on its base, just below the arena) toward the active target.
  function aim() {
    const board = els.targets.querySelector(".target.is-active .target-board");
    if (!board) { els.blaster.style.setProperty("--aim", "0deg"); return; }
    const arena = els.blaster.offsetParent.getBoundingClientRect();
    const t = center(board.getBoundingClientRect(), arena);
    const deg = Math.atan2(t.x - arena.width / 2, arena.height + 90 - t.y) * 180 / Math.PI;
    // Capped so it reads as first-person; the beam itself still goes straight to the target.
    els.blaster.style.setProperty("--aim", `${Math.max(-22, Math.min(22, deg)).toFixed(2)}deg`);
  }

  function restartAnimation(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // force a reflow so the animation plays again
    node.classList.add(cls);
  }

  // Muzzle flash, then a beam to the project's target and a "+1h" on impact.
  function fire(projectKey, hours) {
    document.dispatchEvent(new CustomEvent("dwl:fire", { detail: { key: projectKey, text: `+${formatHours(hours)}` } }));
    restartAnimation(els.blaster, "recoil");
    const target = [...els.targets.children].find((n) => n.dataset.key === projectKey);
    if (!target) return;
    const arena = els.beam.offsetParent.getBoundingClientRect();
    const m = center(els.muzzle.getBoundingClientRect(), arena);
    const t = center(target.querySelector(".target-board").getBoundingClientRect(), arena);
    const len = Math.hypot(t.x - m.x, t.y - m.y);
    const deg = Math.atan2(t.x - m.x, m.y - t.y) * 180 / Math.PI;
    Object.assign(els.beam.style, { left: `${m.x}px`, top: `${m.y - len}px`, height: `${len}px`, transform: `rotate(${deg}deg)` });
    restartAnimation(els.beam, "fire");
    setTimeout(() => {
      restartAnimation(target, "hit");
      const pop = el("span", { class: "hit-pop", text: `+${formatHours(hours)}` });
      target.append(pop);
      setTimeout(() => pop.remove(), 1700);
    }, 160);
  }

  function renderLastShot(highlightId) {
    const endOf = (e) => e.started.getTime() + e.seconds * 1000;
    const latest = state.entries.find((e) => highlightId && e.id === highlightId) ||
      state.entries.reduce((a, e) => (!a || endOf(e) > endOf(a) ? e : a), null);
    els.lastShot.classList.toggle("has-shot", !!latest);
    if (!latest) {
      els.lastShotTitle.textContent = "Ready to fire";
      els.lastShotBody.replaceChildren("Pick a project, pick a task, and shoot your first hour.");
      return;
    }
    const projectKey = latest.issueKey.split("-")[0];
    els.lastShotTitle.textContent = highlightId ? "Time logged!" : "Last shot";
    els.lastShotBody.replaceChildren(
      el("div", { class: "ls-project" },
        el("span", { class: "p-icon", style: `--c:${projectColor(projectKey)}`, text: projectName(projectKey).charAt(0).toUpperCase() }),
        projectName(projectKey)),
      el("div", { class: "ls-task", title: latest.summary, text: `${latest.issueKey} · ${latest.summary}` }),
      el("div", { class: "ls-time", text: `⏱ ${formatHours(latest.hours)} · ${formatTime(latest.started)} – ${formatTime(new Date(endOf(latest)))}` }),
      el("div", { class: "ls-cheer", text: CHEERS[hash(latest.id || latest.issueKey) % CHEERS.length] }));
    if (highlightId) restartAnimation(els.lastShot, "pop");
  }

  // ---------- Tasks ----------

  function renderTaskSkeleton() {
    els.taskList.setAttribute("aria-busy", "true");
    els.taskCount.textContent = "";
    const rows = Array.from({ length: 5 }, (_, i) =>
      el("div", { class: "skeleton-row", "aria-hidden": "true" },
        el("span", { class: "skeleton-line", style: "width:14px;height:14px;border-radius:50%" }),
        el("span", { class: "skeleton-line", style: "width:64px" }),
        el("span", { class: "skeleton-line", style: `flex:1;max-width:${60 + ((i * 17) % 35)}%` }))
    );
    els.taskList.replaceChildren(...rows);
  }

  function renderTaskEmpty(title, body) {
    els.taskList.setAttribute("aria-busy", "false");
    els.taskList.replaceChildren(el("div", { class: "empty" }, el("strong", { text: title }), body));
    els.taskCount.textContent = "";
    updateSubmitState();
  }

  async function loadIssues() {
    const project = els.project.value;
    const req = ++state.issuesRequest;
    state.issues = [];
    state.selectedKey = null;
    updateSubmitState();
    if (!project) return;
    renderTaskSkeleton();
    try {
      const issues = await Jira.getIssues(project, { storiesOnly: els.storiesOnly.checked });
      if (req !== state.issuesRequest) return; // a newer request superseded this one
      state.issues = issues;
      renderIssues();
    } catch (err) {
      if (req !== state.issuesRequest) return;
      renderTaskEmpty("Couldn't load tasks", err.auth ? "Sign in to Jira and reload." : err.message);
      handleError(err, "Couldn't load tasks");
    }
  }

  function renderIssues() {
    els.taskList.setAttribute("aria-busy", "false");
    if (!state.issues.length) {
      const what = els.storiesOnly.checked ? "open Stories or subtasks" : "open issues";
      renderTaskEmpty(`No ${what} assigned to you`,
        els.storiesOnly.checked ? "Try turning off \"Stories & subtasks\"." : "Nothing to log against in this project.");
      return;
    }

    const q = els.taskFilter.value.trim().toLowerCase();
    const byKey = new Map(state.issues.map((i) => [i.key, i]));
    const matches = (i) => [i.key, i.summary].some((v) => v && v.toLowerCase().includes(q));

    // A match on a parent shows its sub-tasks; a match on a sub-task shows its parent for context.
    const shown = new Set();
    for (const i of state.issues) {
      if (q && !matches(i) && !(i.parent && byKey.has(i.parent.key) && matches(byKey.get(i.parent.key)))) continue;
      shown.add(i.key);
      if (i.parent && byKey.has(i.parent.key)) shown.add(i.parent.key);
    }

    // Group sub-tasks under their parent; groups keep Jira's order (most recently updated first).
    const groups = new Map();
    for (const i of state.issues) {
      if (!shown.has(i.key)) continue;
      const top = i.parent && byKey.has(i.parent.key) ? i.parent.key : i.key;
      if (!groups.has(top)) groups.set(top, []);
      if (top !== i.key) groups.get(top).push(i);
    }
    const rows = [];
    for (const [top, children] of groups) {
      rows.push({ issue: byKey.get(top), child: false });
      for (const c of children) rows.push({ issue: c, child: true });
    }

    if (!rows.length) {
      els.taskList.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "No matches" }), `Nothing matches "${els.taskFilter.value.trim()}".`));
    } else {
      els.taskList.replaceChildren(...rows.map(({ issue, child }) => {
        // Only show the parent line when the parent isn't directly above.
        const parentText = issue.parent && !child ? `${issue.parent.key} · ${issue.parent.summary}` : "";
        const notMine = !issue.mine && issue.assignee ? `Assigned to ${issue.assignee}` : (!issue.mine ? "Unassigned" : "");
        const meta = [parentText && `↳ ${parentText}`, notMine].filter(Boolean).join(" · ");
        const input = el("input", {
          type: "radio", name: "task", value: issue.key,
          checked: issue.key === state.selectedKey,
          "aria-label": `${issue.key} ${issue.summary}, ${issue.status}` +
            (issue.parent ? `, ${issue.type || "subtask"} of ${issue.parent.key}` : "") +
            (notMine ? `, ${notMine}` : ""),
        });
        return el("label", { class: `task${issue.subtask ? " is-subtask" : ""}${child ? " is-child" : ""}`, title: issue.summary, "data-key": issue.key },
          input,
          el("span", { class: "task-main" },
            el("span", { class: "task-line" },
              issue.subtask ? el("span", { class: "task-type", text: "Subtask" }) : null,
              el("span", { class: "task-key", text: issue.key }),
              el("span", { class: "task-summary", text: issue.summary })),
            meta ? el("span", { class: "task-parent", title: meta, text: meta }) : null),
          el("span", { class: "task-today", title: "Logged today" }),
          el("span", { class: `pill ${issue.category}`, text: issue.status }));
      }));
      updateTaskBadges();
    }

    els.taskCount.textContent = q
      ? `${rows.length} of ${state.issues.length} tasks`
      : `${state.issues.length} task${state.issues.length === 1 ? "" : "s"}`;
    updateSubmitState();
  }

  // Hours already logged today on each task, updated in place so focus in the list survives.
  function updateTaskBadges() {
    const today = sumHoursBy((e) => e.issueKey);
    els.taskList.querySelectorAll(".task[data-key]").forEach((row) => {
      const h = today.get(row.dataset.key);
      row.querySelector(".task-today").textContent = h ? formatHours(h) : "";
    });
  }

  // ---------- Today's entries ----------

  function renderEntriesSkeleton() {
    els.entries.setAttribute("aria-busy", "true");
    els.entries.replaceChildren(...Array.from({ length: 3 }, () =>
      el("li", { class: "skeleton-row", "aria-hidden": "true" },
        el("span", { class: "skeleton-line", style: "width:40%" }),
        el("span", { class: "skeleton-line", style: "width:85%" }),
        el("span", { class: "skeleton-line", style: "width:30%;height:10px" }))));
  }

  function renderProgress(totalHours) {
    const pct = Math.min(100, (totalHours / TARGET_HOURS) * 100);
    els.totalLabel.textContent = formatHours(totalHours) === "0m" ? "0h" : formatHours(totalHours);
    els.targetLabel.textContent = `${TARGET_HOURS}h`;
    els.progressFill.style.width = `${pct}%`;
    els.progressPct.textContent = `${Math.floor(pct)}%`;
    els.progressFill.classList.toggle("complete", totalHours >= TARGET_HOURS);

    const rank = RANKS.find((r) => totalHours / TARGET_HOURS >= r.min);
    els.rankIcon.textContent = rank.icon;
    els.rankTitle.textContent = rank.title;
    els.rankText.textContent = rank.text;
    els.rank.classList.toggle("on-fire", totalHours >= TARGET_HOURS);
    els.progress.setAttribute("aria-valuemax", String(TARGET_HOURS));
    els.progress.setAttribute("aria-valuenow", String(Math.round(totalHours * 100) / 100));
    els.progress.setAttribute("aria-valuetext", `${formatHours(totalHours)} of ${TARGET_HOURS} hours`);
  }

  function renderEntries(highlightId) {
    els.entries.setAttribute("aria-busy", "false");
    const total = state.entries.reduce((s, e) => s + e.hours, 0);
    renderProgress(total);
    renderLastShot(highlightId);
    renderArena();
    updateTaskBadges();
    els.hitCount.textContent = state.entries.length ? `(${state.entries.length})` : "";

    if (!state.entries.length) {
      els.entries.replaceChildren(el("li", { class: "empty" },
        el("strong", { text: "Nothing logged yet today" }), "Entries you log will appear here."));
      return;
    }

    // Newest first in the panel.
    const sorted = [...state.entries].sort((a, b) => b.started - a.started);
    els.entries.replaceChildren(...sorted.map((e) => {
      const end = new Date(e.started.getTime() + e.seconds * 1000);
      return el("li", { class: `entry${e.id === highlightId ? " new" : ""}` },
        el("div", { class: "entry-top" },
          el("a", { class: "entry-key", href: issueUrl(e.issueKey), target: "_blank", rel: "noopener", text: e.issueKey }),
          el("span", { class: "entry-meta", text: `${formatTime(e.started)} – ${formatTime(end)}` }),
          el("span", { class: "entry-hours", text: formatHours(e.hours) })),
        el("div", { class: "entry-summary", title: e.summary, text: e.summary }),
        e.note ? el("div", { class: "entry-note", text: e.note }) : null);
    }));
  }

  // Suggest the next start time: end of the latest entry today, else 09:00.
  function suggestStart() {
    if (!state.entries.length) return;
    const latestEnd = Math.max(...state.entries.map((e) => e.started.getTime() + e.seconds * 1000));
    const d = new Date(latestEnd);
    const now = new Date();
    if (d.toDateString() !== now.toDateString()) return;
    els.start.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function loadToday({ highlightId, silent } = {}) {
    if (!silent) renderEntriesSkeleton();
    els.refreshToday.setAttribute("aria-busy", "true");
    els.refreshToday.disabled = true;
    try {
      state.entries = await Jira.getTodaysWorklogs();
      state.entriesLoaded = true;
      renderEntries(highlightId);
      suggestStart();
      return true;
    } catch (err) {
      els.entries.setAttribute("aria-busy", "false");
      if (!silent) {
        els.entries.replaceChildren(el("li", { class: "empty" },
          el("strong", { text: "Couldn't load today's entries" }), err.auth ? "Sign in to Jira and reload." : err.message));
        renderProgress(0);
      }
      handleError(err, "Couldn't load today's entries");
      return false;
    } finally {
      els.refreshToday.setAttribute("aria-busy", "false");
      els.refreshToday.disabled = false;
    }
  }

  // ---------- Team sheet ----------

  function setSyncStatus(stateName, text) {
    els.syncStatus.dataset.state = stateName;
    els.syncStatus.replaceChildren(text);
  }

  // Sends today's full list of entries, so the sheet row always matches Jira
  // (including time logged directly in Jira). Only runs after a successful fetch,
  // so a failed refresh can never overwrite the row with partial data.
  async function syncSheet() {
    if (!state.entriesLoaded || state.syncing) return;
    state.syncing = true;
    els.syncNow.disabled = true;
    setSyncStatus("busy", "Updating team sheet…");
    try {
      const me = await Jira.getMyself();
      const names = new Map(state.projects.map((p) => [p.key, p.name]));
      const entries = state.entries.map((e) => {
        const projectKey = e.issueKey.split("-")[0];
        return { projectKey, projectName: names.get(projectKey) || projectKey, issueKey: e.issueKey, summary: e.summary, seconds: e.seconds };
      });
      await Sheet.syncDay({ date: Sheet.localIsoDate(), developer: me.displayName, accountId: me.accountId, entries });
      setSyncStatus("ok", `Team sheet updated at ${formatTime(new Date())}`);
    } catch (err) {
      console.error("[Daily Work Log] Sheet sync failed:", err);
      setSyncStatus("error", "Team sheet not updated");
      toast(`Couldn't update the team sheet: ${err.message}`, "error");
    } finally {
      state.syncing = false;
      els.syncNow.disabled = false;
    }
  }

  // ---------- Form ----------

  function updateSubmitState() {
    els.submit.disabled = state.submitting || !state.selectedKey;
  }

  function syncChips() {
    const h = Number(els.hours.value);
    document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(Number(c.dataset.hours) === h)));
  }

  function showFormError(msg) {
    els.formError.textContent = msg;
    els.formError.hidden = !msg;
  }

  function startedDate() {
    const [hh, mm] = (els.start.value || "09:00").split(":").map(Number);
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    return d;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state.submitting) return;
    showFormError("");

    const key = state.selectedKey;
    const hours = Number(els.hours.value);
    if (!key) return showFormError("Pick a task to log time against.");
    if (!Number.isFinite(hours) || hours <= 0) {
      els.hours.focus();
      return showFormError("Enter the hours you spent (e.g. 0.25, 1.5).");
    }
    if (hours > 24) {
      els.hours.focus();
      return showFormError("That's more than 24 hours.");
    }
    if (!els.start.value) {
      els.start.focus();
      return showFormError("Enter the time you started.");
    }

    state.submitting = true;
    updateSubmitState();
    els.submit.setAttribute("aria-busy", "true");
    els.submit.querySelector(".btn-label").textContent = "Logging…";

    try {
      const worklog = await Jira.logWork(key, hours, els.note.value, startedDate());
      fire(key.split("-")[0], hours);
      toast(`Logged ${formatHours(hours)} on ${key}.`, "success");
      rememberProject(key.split("-")[0]);
      els.note.value = "";
      // Don't hold the form while the sheet updates.
      loadToday({ highlightId: worklog && worklog.id, silent: true }).then((ok) => { if (ok) syncSheet(); });
    } catch (err) {
      handleError(err, `Couldn't log time on ${key}`);
      if (!err.auth) showFormError(err.message);
      restartAnimation(els.blaster, "miss");
      document.dispatchEvent(new CustomEvent("dwl:miss"));
    } finally {
      state.submitting = false;
      els.submit.removeAttribute("aria-busy");
      els.submit.querySelector(".btn-label").textContent = "Shoot time";
      updateSubmitState();
    }
  }

  // ---------- Keyboard ----------

  const DURATIONS = [0.25, 0.5, 1, 2, 4];
  let spaceHandled = false;

  function isTextField(node) {
    return !!(node.closest && node.closest(
      "textarea, select, [contenteditable], input:not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit])"));
  }

  function stepProject(delta) {
    const keys = state.arenaKeys;
    if (!keys.length) return;
    const i = keys.indexOf(els.project.value);
    const next = i < 0 ? (delta > 0 ? 0 : keys.length - 1) : (i + delta + keys.length) % keys.length;
    selectProject(keys[next]);
  }

  function stepTask(delta) {
    const radios = [...els.taskList.querySelectorAll('input[name="task"]')];
    if (!radios.length) return;
    const i = radios.findIndex((r) => r.checked);
    const next = radios[i < 0 ? (delta > 0 ? 0 : radios.length - 1) : Math.min(radios.length - 1, Math.max(0, i + delta))];
    next.checked = true;
    next.dispatchEvent(new Event("change", { bubbles: true }));
    next.closest(".task").scrollIntoView({ block: "nearest" });
  }

  // Moves between the quick durations; from an in-between value it goes to the nearest one in that direction.
  function stepDuration(delta) {
    const h = Number(els.hours.value) || 1;
    let i = DURATIONS.findIndex((d) => d >= h);
    if (i < 0) i = DURATIONS.length;
    const next = delta > 0 ? (DURATIONS[i] === h ? i + 1 : i) : i - 1;
    if (next < 0 || next >= DURATIONS.length) return;
    els.hours.value = DURATIONS[next];
    syncChips();
  }

  function shoot() {
    if (state.submitting) return;
    if (!state.selectedKey) return showFormError("Pick a task to log time against (↑ ↓).");
    els.form.requestSubmit();
  }

  function openKeys() {
    if (!els.keysHelp.open) els.keysHelp.showModal();
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || els.keysHelp.open) return;
    const t = e.target;
    if (e.key === "Escape") {
      if (t === els.taskFilter && els.taskFilter.value) return; // the search box clears itself first
      if (isTextField(t)) t.blur();
      return;
    }
    if (isTextField(t)) return;

    // Arrow keys on a task radio already move the selection natively.
    const onRadio = t.matches && t.matches('input[type="radio"]');
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (/^[1-9]$/.test(key)) {
      const k = state.arenaKeys[Number(key) - 1];
      if (k) selectProject(k); else handled = false;
    } else {
      switch (key) {
        case "ArrowLeft": case "ArrowRight":
          if (onRadio) handled = false; else stepProject(key === "ArrowLeft" ? -1 : 1);
          break;
        case "a": case "d": stepProject(key === "a" ? -1 : 1); break;
        case "ArrowUp": case "ArrowDown":
          if (onRadio) handled = false; else stepTask(key === "ArrowUp" ? -1 : 1);
          break;
        case "w": case "s": stepTask(key === "w" ? -1 : 1); break;
        case "q": case "e": stepDuration(key === "q" ? -1 : 1); break;
        case " ":
          if (t.matches && t.matches('input[type="checkbox"]')) handled = false;
          else if (!e.repeat) shoot();
          break;
        case "/": els.taskFilter.focus(); break;
        case "n": els.note.focus(); break;
        case "?": openKeys(); break;
        default: handled = false;
      }
    }
    if (handled) {
      e.preventDefault();
      spaceHandled = key === " ";
    }
  }

  // ---------- Wire up ----------

  function bind() {
    els.openJira.addEventListener("click", () => Jira.openJiraTab());
    els.reload.addEventListener("click", () => location.reload());

    els.project.addEventListener("change", () => { els.taskFilter.value = ""; renderArena(); loadIssues(); });
    for (const box of [els.weapons, els.targets]) {
      box.addEventListener("click", (e) => {
        const pick = e.target.closest("[data-key]");
        if (pick) selectProject(pick.dataset.key);
      });
    }
    els.sessionPause.addEventListener("click", toggleSession);

    document.addEventListener("keydown", onKeyDown);
    // Space is "shoot" even on a focused button, so stop that button's own click on keyup.
    document.addEventListener("keyup", (e) => {
      if (e.key === " " && spaceHandled) { e.preventDefault(); spaceHandled = false; }
    });
    els.keysOpen.addEventListener("click", openKeys);
    els.keysClose.addEventListener("click", () => els.keysHelp.close());
    els.keysHelp.addEventListener("click", (e) => { if (e.target === els.keysHelp) els.keysHelp.close(); });
    window.addEventListener("resize", () => requestAnimationFrame(aim));
    els.storiesOnly.addEventListener("change", loadIssues);
    els.taskFilter.addEventListener("input", () => { if (state.issues.length) renderIssues(); });

    els.taskList.addEventListener("change", (e) => {
      if (e.target.name === "task") {
        state.selectedKey = e.target.value;
        showFormError("");
        updateSubmitState();
      }
    });

    document.querySelectorAll(".chip").forEach((chip) =>
      chip.addEventListener("click", () => { els.hours.value = chip.dataset.hours; syncChips(); }));
    els.hours.addEventListener("input", syncChips);

    els.refreshToday.addEventListener("click", () => loadToday());
    els.syncNow.addEventListener("click", async () => { if (await loadToday({ silent: true })) syncSheet(); });
    els.form.addEventListener("submit", onSubmit);

    // Ctrl/Cmd+Enter submits from the note field.
    els.note.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) els.form.requestSubmit();
    });
  }

  function init() {
    renderDate();
    startSession();
    renderArenaPlaceholders();
    renderTaskSkeleton();
    renderEntriesSkeleton();
    syncChips();
    bind();
    loadUser();
    loadProjects();
    loadToday();
  }

  init();
})();
