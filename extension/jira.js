// Jira Cloud client for the Daily Work Log extension.
// Uses the browser's existing Atlassian session cookies (credentials: "include");
// no API token and no backend. Exposes a single global: Jira.
(function () {
  "use strict";

  const BASE = "https://newagesmb.atlassian.net";
  const HEADERS = { Accept: "application/json", "X-Atlassian-Token": "no-check" };
  const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;
  const XSRF_RULE_ID = 1;

  class JiraError extends Error {
    constructor(message, { status = 0, auth = false, xsrf = false } = {}) {
      super(message);
      this.name = "JiraError";
      this.status = status;
      this.auth = auth; // true -> show the "not signed in" banner
      this.xsrf = xsrf;
    }
  }

  const SIGNED_OUT_MESSAGE =
    "You're not signed in to Jira. Open newagesmb.atlassian.net, sign in, then reload.";

  // Pull the most useful human-readable message out of a Jira error body.
  function extractError(body, status) {
    if (body && typeof body === "object") {
      const parts = [];
      if (Array.isArray(body.errorMessages)) parts.push(...body.errorMessages);
      if (body.errors && typeof body.errors === "object") {
        for (const [field, msg] of Object.entries(body.errors)) parts.push(`${field}: ${msg}`);
      }
      if (body.message) parts.push(body.message);
      if (parts.length) return parts.join(" ");
    }
    if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
    return `Jira request failed (HTTP ${status})`;
  }

  async function rawRequest(path, { method = "GET", body } = {}) {
    const init = { method, credentials: "include", headers: { ...HEADERS } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(BASE + path, init);
    } catch (e) {
      throw new JiraError(`Could not reach Jira: ${e.message}`);
    }

    const type = res.headers.get("content-type") || "";
    const text = await res.text();

    // A redirect to the Atlassian login page, or any HTML where JSON was expected,
    // means the session is missing or expired.
    const looksLikeLogin =
      /id\.atlassian\.com|\/login/i.test(res.url) || (type.includes("text/html") && /<html/i.test(text));
    if (/XSRF check failed/i.test(text)) {
      throw new JiraError("XSRF check failed", { status: res.status, xsrf: true });
    }
    if (res.status === 401 || res.status === 403 || looksLikeLogin) {
      // A 403 with a JSON body can be a genuine permission error (e.g. no "Work on issues"),
      // not a signed-out session, so keep Jira's own message in that case.
      if (res.status === 403 && type.includes("application/json")) {
        let parsed;
        try { parsed = JSON.parse(text); } catch (_) { /* ignore */ }
        const msg = extractError(parsed, 403);
        if (!/login|log in|authenticat/i.test(msg)) throw new JiraError(msg, { status: 403 });
      }
      throw new JiraError(SIGNED_OUT_MESSAGE, { status: res.status, auth: true });
    }

    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = text; }
    }

    if (!res.ok) {
      throw new JiraError(extractError(data, res.status), { status: res.status });
    }
    return data;
  }

  // Jira rejects some extension-origin POSTs with "XSRF check failed" because of the
  // chrome-extension:// Origin header. The fix is a declarativeNetRequest rule that strips
  // Origin from this extension's requests to /rest/*. It's added the first time the
  // error is seen, persists across restarts, and the request is retried once.
  async function enableOriginStripping() {
    const rule = {
      id: XSRF_RULE_ID,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "remove" }] },
      condition: {
        urlFilter: "|https://newagesmb.atlassian.net/rest/",
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest", "other"],
      },
    };
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [XSRF_RULE_ID],
      addRules: [rule],
    });
  }

  async function isOriginStrippingEnabled() {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.some((r) => r.id === XSRF_RULE_ID);
  }

  async function request(path, opts) {
    try {
      return await rawRequest(path, opts);
    } catch (e) {
      if (e.xsrf && !(await isOriginStrippingEnabled())) {
        console.warn("[Daily Work Log] XSRF check failed; enabling Origin-stripping rule and retrying.");
        await enableOriginStripping();
        return rawRequest(path, opts);
      }
      throw e;
    }
  }

  // ---------- Helpers ----------

  function pad(n, w = 2) { return String(n).padStart(w, "0"); }

  // 2026-09-29T09:00:00.000+0530 (local time with local offset, no "Z")
  function formatStarted(date) {
    const off = -date.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
      `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
    );
  }

  // Jira returns "+0530"; normalise to "+05:30" so Date parsing is unambiguous.
  function parseJiraDate(s) {
    return new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  }

  function isSameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // Flatten an Atlassian Document Format node to plain text.
  function adfToText(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (node.type === "text") return node.text || "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === "mention") return node.attrs?.text || "";
    if (node.type === "emoji") return node.attrs?.text || node.attrs?.shortName || "";
    if (node.type === "inlineCard") return node.attrs?.url || "";
    const inner = (node.content || []).map(adfToText).join("");
    const block = ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(node.type);
    return block ? inner + "\n" : inner;
  }

  function flattenComment(comment) {
    return adfToText(comment).replace(/\n{2,}/g, "\n").trim();
  }

  function textToAdf(text) {
    return {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    };
  }

  const CATEGORY = { new: "todo", indeterminate: "prog", done: "done" };

  function assertProjectKey(key) {
    if (!PROJECT_KEY_RE.test(key || "")) throw new JiraError(`Invalid project key: ${key}`);
    return key;
  }

  function assertIssueKey(key) {
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key || "")) throw new JiraError(`Invalid issue key: ${key}`);
    return key;
  }

  // Run async fn over items with a small concurrency limit.
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // POST /rest/api/3/search/jql with nextPageToken pagination.
  async function searchAll(jql, fields) {
    const issues = [];
    let nextPageToken;
    do {
      const body = { jql, fields, maxResults: 50 };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const page = await request("/rest/api/3/search/jql", { method: "POST", body });
      issues.push(...(page.issues || []));
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken);
    return issues;
  }

  // ---------- Public API ----------

  let myselfCache = null;

  async function getMyself() {
    if (!myselfCache) myselfCache = await request("/rest/api/3/myself");
    return myselfCache;
  }

  function initials(displayName) {
    const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase();
  }

  // -> [{ key, name }]
  async function getProjects() {
    const out = [];
    let startAt = 0;
    for (;;) {
      const page = await request(`/rest/api/3/project/search?maxResults=50&startAt=${startAt}`);
      const values = page.values || [];
      out.push(...values.map((p) => ({ key: p.key, name: p.name })));
      startAt += values.length;
      if (page.isLast || !values.length || (page.total != null && startAt >= page.total)) break;
    }
    return out;
  }

  // -> [{ key, summary, status, category, type, subtask, parent: { key, summary } | null }]
  // "Stories only" still includes sub-tasks assigned to you (e.g. a sub-task under someone
  // else's Story), since that's where the time is usually logged.
  async function getIssues(projectKey, { storiesOnly = true } = {}) {
    assertProjectKey(projectKey);
    const jql =
      `project = "${projectKey}"` +
      (storiesOnly ? " AND (type = Story OR type in subTaskIssueTypes())" : "") +
      " AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
    const issues = await searchAll(jql, ["summary", "status", "issuetype", "parent"]);
    return issues.map((i) => {
      const f = i.fields || {};
      return {
        key: i.key,
        summary: f.summary || "",
        status: f.status?.name || "",
        category: CATEGORY[f.status?.statusCategory?.key] || "todo",
        type: f.issuetype?.name || "",
        subtask: !!f.issuetype?.subtask,
        parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || "" } : null,
      };
    });
  }

  // Project keys you've logged time to recently, most recent first (from Jira, so it
  // includes time logged in Jira itself). Ordered by the issue's last update, which is a
  // close proxy for when the worklog was added.
  async function getRecentProjectKeys(limit = 5) {
    const page = await request("/rest/api/3/search/jql", {
      method: "POST",
      body: {
        jql: "worklogAuthor = currentUser() AND worklogDate >= -30d ORDER BY updated DESC",
        fields: ["project"],
        maxResults: 50,
      },
    });
    const keys = [];
    for (const i of page.issues || []) {
      const key = i.fields?.project?.key;
      if (key && !keys.includes(key)) keys.push(key);
      if (keys.length >= limit) break;
    }
    return keys;
  }

  // hours: number; note: string; started: Date (defaults to now)
  async function logWork(issueKey, hours, note, started = new Date()) {
    assertIssueKey(issueKey);
    const seconds = Math.round(Number(hours) * 3600);
    if (!Number.isFinite(seconds) || seconds < 60) {
      throw new JiraError("Time spent must be at least 1 minute.");
    }
    const body = { timeSpentSeconds: seconds, started: formatStarted(started) };
    const trimmed = (note || "").trim();
    if (trimmed) body.comment = textToAdf(trimmed);
    return request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`, { method: "POST", body });
  }

  // Today's worklogs by the current user, oldest first.
  // -> [{ id, issueKey, summary, hours, seconds, started: Date, note }]
  async function getTodaysWorklogs() {
    const me = await getMyself();
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const issues = await searchAll("worklogAuthor = currentUser() AND worklogDate = startOfDay()", ["summary"]);

    const perIssue = await mapLimit(issues, 5, async (issue) => {
      const logs = [];
      let startAt = 0;
      for (;;) {
        const page = await request(
          `/rest/api/3/issue/${encodeURIComponent(issue.key)}/worklog` +
            `?startAt=${startAt}&maxResults=1000&startedAfter=${dayStart.getTime() - 1}`
        );
        const worklogs = page.worklogs || [];
        logs.push(...worklogs);
        startAt += worklogs.length;
        if (!worklogs.length || startAt >= (page.total ?? 0)) break;
      }
      return logs
        .filter((w) => w.author?.accountId === me.accountId)
        .map((w) => ({ w, started: parseJiraDate(w.started) }))
        .filter(({ started }) => isSameLocalDay(started, now))
        .map(({ w, started }) => ({
          id: w.id,
          issueKey: issue.key,
          summary: issue.fields?.summary || "",
          seconds: w.timeSpentSeconds,
          hours: w.timeSpentSeconds / 3600,
          started,
          note: flattenComment(w.comment),
        }));
    });

    return perIssue.flat().sort((a, b) => a.started - b.started);
  }

  function openJiraTab() {
    const url = BASE + "/";
    if (typeof chrome !== "undefined" && chrome.tabs) chrome.tabs.create({ url });
    else window.open(url, "_blank", "noopener");
  }

  window.Jira = {
    BASE,
    SIGNED_OUT_MESSAGE,
    JiraError,
    getMyself,
    initials,
    getProjects,
    getIssues,
    getRecentProjectKeys,
    logWork,
    getTodaysWorklogs,
    openJiraTab,
    // exposed for testing / diagnostics
    _formatStarted: formatStarted,
    _adfToText: flattenComment,
    _isOriginStrippingEnabled: isOriginStrippingEnabled,
  };
})();
