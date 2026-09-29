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
    entries: $("entries"),
    toasts: $("toasts"),
    syncStatus: $("sync-status"),
    syncNow: $("sync-now"),
  };

  const state = {
    issues: [],
    selectedKey: null,
    issuesRequest: 0,
    entries: [],
    submitting: false,
    projects: [],
    recentKeys: [],
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

  // ---------- Projects ----------

  function readLastProject() {
    try { return localStorage.getItem(LAST_PROJECT_KEY); } catch (_) { return null; }
  }

  function rememberProject(key) {
    try { localStorage.setItem(LAST_PROJECT_KEY, key); } catch (_) { /* storage unavailable */ }
    state.recentKeys = [key, ...state.recentKeys.filter((k) => k !== key)].slice(0, 5);
    renderProjectOptions(els.project.value);
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
        return;
      }

      // The project you last logged to from this page wins; then Jira's recent worklogs.
      const last = readLastProject();
      state.recentKeys = [...new Set([last, ...recentFromJira].filter(Boolean))].slice(0, 5);
      renderProjectOptions();
      els.project.disabled = false;
      loadIssues();
    } catch (err) {
      els.project.replaceChildren(el("option", { value: "", text: "Couldn't load projects" }));
      renderTaskEmpty("Tasks unavailable", "Projects couldn't be loaded.");
      handleError(err, "Couldn't load projects");
    } finally {
      els.projectWrap.setAttribute("aria-busy", "false");
    }
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
        return el("label", { class: `task${issue.subtask ? " is-subtask" : ""}${child ? " is-child" : ""}`, title: issue.summary },
          input,
          el("span", { class: "task-main" },
            el("span", { class: "task-line" },
              issue.subtask ? el("span", { class: "task-type", text: "Subtask" }) : null,
              el("span", { class: "task-key", text: issue.key }),
              el("span", { class: "task-summary", text: issue.summary })),
            meta ? el("span", { class: "task-parent", title: meta, text: meta }) : null),
          el("span", { class: `pill ${issue.category}`, text: issue.status }));
      }));
    }

    els.taskCount.textContent = q
      ? `${rows.length} of ${state.issues.length} tasks`
      : `${state.issues.length} task${state.issues.length === 1 ? "" : "s"}`;
    updateSubmitState();
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
    els.totalLabel.textContent = `${formatHours(totalHours) === "0m" ? "0h" : formatHours(totalHours)} logged`;
    els.targetLabel.textContent = `${TARGET_HOURS}h`;
    els.progressFill.style.width = `${pct}%`;
    els.progressFill.classList.toggle("complete", totalHours >= TARGET_HOURS);
    els.progress.setAttribute("aria-valuemax", String(TARGET_HOURS));
    els.progress.setAttribute("aria-valuenow", String(Math.round(totalHours * 100) / 100));
    els.progress.setAttribute("aria-valuetext", `${formatHours(totalHours)} of ${TARGET_HOURS} hours`);
  }

  function renderEntries(highlightId) {
    els.entries.setAttribute("aria-busy", "false");
    const total = state.entries.reduce((s, e) => s + e.hours, 0);
    renderProgress(total);

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

  function renderSyncIdle() {
    if (!Sheet.isConfigured()) {
      els.syncStatus.dataset.state = "off";
      els.syncStatus.replaceChildren("Team sheet not connected · ",
        el("a", { href: "settings.html", text: "Set up" }));
      els.syncNow.hidden = true;
      return;
    }
    setSyncStatus("idle", "Team sheet connected");
    els.syncNow.hidden = false;
  }

  // Sends today's full list of entries, so the sheet row always matches Jira
  // (including time logged directly in Jira). Only runs after a successful fetch,
  // so a failed refresh can never overwrite the row with partial data.
  async function syncSheet() {
    if (!Sheet.isConfigured() || !state.entriesLoaded || state.syncing) return;
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
      toast(`Logged ${formatHours(hours)} on ${key}.`, "success");
      rememberProject(key.split("-")[0]);
      els.note.value = "";
      // Don't hold the form while the sheet updates.
      loadToday({ highlightId: worklog && worklog.id, silent: true }).then((ok) => { if (ok) syncSheet(); });
    } catch (err) {
      handleError(err, `Couldn't log time on ${key}`);
      if (!err.auth) showFormError(err.message);
    } finally {
      state.submitting = false;
      els.submit.removeAttribute("aria-busy");
      els.submit.querySelector(".btn-label").textContent = "Log time";
      updateSubmitState();
    }
  }

  // ---------- Wire up ----------

  function bind() {
    els.openJira.addEventListener("click", () => Jira.openJiraTab());
    els.reload.addEventListener("click", () => location.reload());

    els.project.addEventListener("change", () => { els.taskFilter.value = ""; loadIssues(); });
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
    renderTaskSkeleton();
    renderEntriesSkeleton();
    syncChips();
    renderSyncIdle();
    bind();
    loadUser();
    loadProjects();
    loadToday();
  }

  init();
})();
