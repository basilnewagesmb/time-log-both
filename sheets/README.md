# Team sheet (Google Apps Script)

Each time someone logs time in the Daily Work Log extension, their total for the day goes into a Google Sheet, laid out as one block per day:

| 29 September 2026, Tuesday | | | |
|---|---|---|---|
| **Developer** | **Project** | **Task** | **Hours** |
| Alan Mathew | Georgia | Dashboard | 8 |
| Basil Babu | | | |

- **Project** holds short names from the *Projects* tab, falling back to the Jira project name. **Task** holds the Jira issue titles. Both list the item with the most time first.
- Everyone on the *Team* tab gets a row every day, so blank rows show who hasn't logged yet.
- The extension sends the person's full list of entries for today each time, so their row is replaced, never duplicated. The row also includes time they logged directly in Jira.

## One-time setup (sheet owner)

1. Create a Google Sheet, then open **Extensions → Apps Script**.
2. Replace `Code.gs` with [Code.gs](Code.gs).
3. In **Project Settings**, tick *Show "appsscript.json"*, then replace its contents with [appsscript.json](appsscript.json). This sets the time zone to Asia/Kolkata.
4. Select `setup` in the function dropdown and click **Run**, then approve the permissions. It creates the **Log**, **Team** and **Projects** tabs and prints a **token** in the execution log. You can also find the token later under Project Settings → Script properties → `TOKEN`.
5. Fill in the tabs:
   - **Team:** one developer per row, in the order you want them listed. Spell names as they appear in Jira, e.g. `Basil Babu`. The Jira account ID column fills itself in the first time each person syncs.
   - **Projects:** a Jira key and a short name, e.g. `GEOR` → `Georgia`, `WHIP` → `WhipFlip`.
6. Click **Deploy → New deployment → Web app**, with:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**. The extension doesn't sign in to Google; the token is what protects the endpoint.
   
   Copy the **Web app URL**. It ends in `/exec`.
7. Share the URL and token with the team privately, e.g. in a Chat DM. Don't put them in the repo.

When you change `Code.gs`, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the same.

> If your Google Workspace admin blocks "Anyone" access for web apps, you'll only see "Anyone within newagesmb.com". That setting won't work here, because the extension's requests don't carry a Google sign-in.

## Each developer

In the extension, click the ⚙ icon (top right), paste the web app URL and token, then click **Save & test**. The Today panel shows "Team sheet updated at …" after each log. If a sync failed, click **Sync now**.

## 5 PM reminder (cron-job.org → Google Chat)

1. In the Chat space, open **Apps & integrations → Webhooks → Add webhook** and copy its URL.
2. On https://console.cron-job.org, create a job:
   - **URL:** the webhook URL
   - **Schedule:** every day at 17:00, time zone Asia/Kolkata. Mon–Fri only if you prefer.
   - **Advanced → Request method:** `POST`
   - **Headers:** `Content-Type: application/json; charset=UTF-8`
   - **Request body:**
     ```json
     {"text": "<users/all> Time to log today's work ⏱️\nOpen *Daily Work Log* from the Chrome toolbar, or: chrome-extension://EXTENSION_ID/worklog.html"}
     ```
     Replace `EXTENSION_ID` with the ID shown on the extension's card in `chrome://extensions`. It's the same for everyone once the manifest `key` is in place.
3. **Optional:** add a second job at 16:59 that calls `WEB_APP_URL?action=prepare&token=TOKEN` with `GET`. This creates today's block with a blank row for everyone before the reminder goes out.

**About the link:** a webhook posts to the whole space, not to each person privately, and `<users/all>` notifies everyone in it. Chrome only opens a `chrome-extension://` link for people who have the extension installed. Google Chat may also show it as plain text instead of a clickable link; if so, the message still tells people to click the toolbar icon.
