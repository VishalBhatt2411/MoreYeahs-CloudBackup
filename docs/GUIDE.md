# MoreYeahs CloudBackup: Guide

A hosted app that backs up a Salesforce org: **metadata** and **record data**. It never writes to Salesforce.

## How it works

- You (the platform owner) create **one** Salesforce Connected App, once.
- You save its Client ID and Secret **inside the app** (Platform admin screen). They are stored encrypted in the database.
- Customers sign up, click **Connect Salesforce**, and log in to Salesforce. They never see or paste a Client ID or Secret.

## 1. First-time setup on your PC

You need Node.js 20 or newer.

```bash
npm install
```

```bash
npm run setup
```

`npm run setup` creates `backend/.env` with random **server** secrets (they protect login cookies and stored tokens). No Salesforce details go in this file.

Start the local database (leave this window open):

```bash
npm run db:start
```

Create the tables (once):

```bash
npm run db:migrate
```

Start the app:

```bash
npm run dev
```

Open http://localhost:5173

## 2. Make yourself the platform admin

**The first account ever created on a fresh install is the platform admin automatically.** Open http://localhost:5173/register and create your account. You will see **Platform setup** in the menu. Every account after that is a normal customer.

**When you host it for real: register your own account first, right after you deploy, before anyone else can reach the site.**

Fallback: if another account is already the admin, or you need to promote someone, run the command below. It asks for the email and **you type the password** (never share it in chat):

```bash
npm run create-admin
```

Then sign out and sign in again.

## 3. Create the Connected App in Salesforce (about 5 minutes)

In your Developer Edition org:

1. **Setup → App Manager → New Connected App**.
2. Name: `MoreYeahs CloudBackup`. Add your contact email.
3. Turn on **Enable OAuth Settings**.
4. Callback URL: `http://localhost:5173/api/oauth/salesforce/callback`
   (The platform screen shows the exact URL and a Copy button. When you host the app, use `https://YOUR-DOMAIN/api/oauth/salesforce/callback` and set `APP_URL` to `https://YOUR-DOMAIN`.)
5. Scopes: **api**, **refresh_token / offline_access**, **id**.
6. Turn on **Require Proof Key for Code Exchange (PKCE)**.
7. Save. Wait a few minutes. Salesforce is slow to activate new apps.
8. Open the app → **Manage Consumer Details** → copy the **Consumer Key** and **Consumer Secret**.

Then in CloudBackup: **Platform setup** → paste both → **Save** → **Test with Salesforce**.

### Set up email (once, for the whole platform)

Backup failure alerts and team invitations are sent as email. The platform admin enters the mail account once, on **Platform setup → Email (SMTP)**. Nothing goes in an env file.

1. Get SMTP details from your email provider (Microsoft 365, Google Workspace, SendGrid, Amazon SES, your own server, and so on): host, port, user name, password.
2. Enter them, plus the **From** address and a sender name.
   - Port **587** (most providers) starts plain and upgrades to TLS. Leave "Secure connection from the start" off.
   - Port **465** needs "Secure connection from the start" on. The screen switches it for you when you type 465.
3. **Save**, then **Send a test email**. It goes to your own address. If it fails, the screen says why in plain words (wrong password, address not found, connection refused, timed out).
4. The password is stored encrypted and is never shown again. **Remove** deletes the settings.

Until email is set up, nothing breaks: alerts are simply not sent, and invite links are shared by hand.

**Callback URL: what it is.** It is the address Salesforce sends the customer back to after login, so this app can receive the login code. It must be **this app's own address** (above), not `login.salesforce.com`. `login.salesforce.com` is where the login page lives; it is chosen automatically by the Production/Sandbox choice. If the Callback URL in Salesforce is anything other than the exact address above, Salesforce shows `redirect_uri_mismatch`.

**Refresh token rotation.** Newer Salesforce apps force "Enable Refresh Token Rotation" on. Salesforce then issues a new refresh token every time the app renews its login and cancels the old one. CloudBackup saves the newest one each time. (An older build did not, and the second renewal failed with "Salesforce no longer accepts the saved login". If you see that on an org connected before this fix, click **Connect** again once.)

**IP Relaxation.** The default "Enforce IP restrictions" is fine locally. When hosted, if a customer's org limits login IP addresses, choose "Relax IP restrictions" on the app, or the server's address will be refused.

If **Test with Salesforce** shows "retry your request", the new Connected App is usually still activating. Wait about 10 minutes and test again.

## 4. Take a backup

1. **Organizations → Connect Salesforce**. Choose Production or Sandbox. Log in at Salesforce and allow access.
2. Open the org. Click **Start backup**. Optionally pick objects.
3. Open **Backup runs → Details**. You see, for each item, what Salesforce said exists ("expected"), what was saved, the size, and a SHA-256 checksum.
4. **Download everything (.zip)** or download single files.
5. Optionally set **Automatic backups** (every 6 h, 12 h, day, week).

### Dashboard and Settings

- **Dashboard** (the home page) shows connected orgs, running backups, stored data, the next scheduled backup, a **Needs attention** list (failed, partial, overdue, never backed up, reconnect needed), the last 30 days by result, and recent backups.
- **Settings** (owners can change; others can look):
  - **Time zone**: every date in the app uses it.
  - **Default schedule**: given to each org you connect later. **Apply to all connected orgs now** sets it on existing orgs.
  - **Retention**: delete finished backups older than N days (checked every hour). The screen shows how many backups would go before you save. The newest good backup of each org is always kept, and running backups are never touched. Empty means keep forever.
  - **Alerts**: an email is sent when a backup **fails** or an org **needs to be reconnected**. Partial backups show on the Dashboard only. It goes to the **Alert email** if you set one, otherwise to every active owner. One email per failed backup, never more. The owner can press **Send a test alert**, and the last 5 alerts are listed with whether they were sent. If the mail server refuses a message, that is shown there too, and the backup itself still shows as failed.
  - **Sign-in length**, **change my password**, and a read-only **role permissions** table.
  - **Team**: invite people, change roles, switch people off. A switched-off person is signed out at once and cannot sign in.
- **Inviting someone**: Settings → Team → enter email and role → **Invite**. If email is set up, the invitation is emailed. The link is also shown once, so you can copy it and send it yourself (for example if the email does not arrive). It works 7 days, and works once. The person opens it, picks a name and password, and joins your company.

### Forgot password

- On the sign-in page, click **Forgot password?**, enter the email, and an email with a link is sent. The page gives the same answer whether or not an account exists, so nobody can use it to find out who has an account.
- The link works **once** and for **1 hour**. Only one email per minute is sent for an account. Switched-off people get no email.
- Choosing a new password **signs the person out everywhere** (all other browsers and devices). They then sign in with the new password. Older reset links stop working too.
- It needs email to be set up (see above). Without it, the page says so. If the only admin is locked out and email is not set up, use `npm run create-admin` (section 2).
- Reset requests and completed resets appear in the **Activity log**.

### What the run status means

- **Succeeded**: every item was copied, re-read, and the checksum matched.
- **Partial**: some items failed or were skipped. The reason is shown on each item.
- **Failed**: nothing usable was saved.

### Incremental backups and big objects

- By default a backup reads from Salesforce **only the records that changed** since the last good backup, and carries the rest over. Each backup is still a **complete, self-contained snapshot**: you can download or browse it without needing the earlier ones.
- Deleted records are found with Salesforce's `IsDeleted` flag. The watermark is taken 120 seconds back, so records changed during the previous backup are not missed.
- Every backup is checked against Salesforce's row count. If the counts do not match, the object is read again in full, so a wrong snapshot is never reported as good.
- To read everything again, tick **Read everything again (full copy)** when you start a backup. A full copy is also forced once the last one is older than `FULL_REFRESH_DAYS` (default 7).
- Objects with at least `BULK_THRESHOLD_ROWS` rows (default 50,000) are read with the **Bulk API 2.0**. Smaller ones use the REST API.
- The run page shows whether it was incremental or a full copy, and for each object how many records changed and were deleted.

### Data explorer

**Data explorer** (in the menu) lets you look inside a finished backup without downloading it: pick an org, a backup and an object, then page through and search the records. **Download CSV** exports the object (not available to Auditors). The Browse records button on a run page opens the same view.

### The job queue and the worker

- Backups are queued in the database (PostgreSQL), so they survive a restart. If the server stops mid-backup, another worker picks the run up after its lease runs out, and the run page shows the attempt number. A backup is tried at most 3 times.
- Each org can have **one running and one waiting** backup. A third request is refused with a clear message.
- By default the web server also runs the backups (`WORKER_MODE=embedded`). For more customers, set `WORKER_MODE=external` on the web server and run `npm run worker` as a separate process (it can run on another machine with the same `DATABASE_URL` and storage). `WORKER_CONCURRENCY` (default 2) is how many backups one worker runs at once.

### Accounts and data protection

- **Email confirmation at sign-up.** When email is set up, a new company owner must open the emailed link (works once, 24 hours) before signing in. They can ask for a new link once a minute. The first account (platform admin) and invited people skip this. Without email set up, sign-up works as before.
- **Auditor role.** An Auditor can see everything, including the data explorer, but cannot download files, export CSV, start backups or change settings. Use it for people who must look but not take data out.
- **Reset email for a team member.** Owners can press **Send reset email** next to a person in Settings → Team. The person gets the normal one-hour reset link. It needs email to be set up.
- **Legal hold** (owner only, Settings → Data protection). While it is on, nothing is deleted: retention, **Delete all backups** and **Delete the whole company** are all blocked. Turn it off to allow deletion again. The reason and time are recorded.
- **Delete all backups** removes every stored backup but keeps the company and connected orgs. You must type the company name.
- **Delete the whole company** removes the company, its people, orgs, settings and every stored backup, and cannot be undone. You must type the company name and your password. Because the company's own activity log is deleted with it, a short platform-level record is kept (company name and who did it).

### Environment variables for these features

| Variable | Default | Meaning |
|---|---|---|
| `STORAGE_DRIVER` | `local` | Where backup files are kept. Only the server's disk (`STORAGE_DIR`) is built. |
| `WORKER_MODE` | `embedded` | `embedded` or `external` (see the job queue above). |
| `WORKER_CONCURRENCY` | `2` | Backups one worker runs at once (1 to 16). |
| `BULK_THRESHOLD_ROWS` | `50000` | Use the Bulk API 2.0 from this many rows. |
| `FULL_REFRESH_DAYS` | `7` | Force a full copy when the last one is older than this. `0` turns off incremental reuse. |

## 5. Customers' orgs (hosted use)

The one shared Connected App must be usable in each customer org. Salesforce may require the customer's admin to allow it: **Setup → Connected Apps OAuth Usage** (or install it). If login says the app is blocked, this is why. For wide public use, Salesforce may also want a managed package or a reviewed Connected App. Check Salesforce's current rules before you launch.

## 6. Going live (hosting)

- Needs a PostgreSQL database and a server that can run Node.
- Set these environment variables on the server: `DATABASE_URL`, `APP_URL` (your https address), `JWT_SECRET` (long random), `TOKEN_ENCRYPTION_KEY` (64 hex characters), `STORAGE_DIR` (a disk that is kept and backed up).
- `npm run build`, `npm run db:migrate`, `npm start`. The server also serves the website.
- Keep `TOKEN_ENCRYPTION_KEY`. If you lose it, stored Salesforce logins cannot be read and customers must reconnect.
- Use HTTPS. Backups hold customer data, so back up `STORAGE_DIR` too.

## 7. Checks that were done

- Backend: 117 automated tests pass (login, encryption, connect flow, backup, honest status, settings, team invites, retention, dashboard, email settings, failure alerts, invitation email, password reset, job queue and restart recovery, incremental and Bulk API copies, data explorer, email confirmation, Auditor role, legal hold and deletion). They use a **fake Salesforce** and a **fake mail server**.
- Email: a real test email was received with the owner's SMTP details, and the owner confirmed email works. Sign-up confirmation and the reset-for-a-team-member email use the same mail code and are covered by tests with the fake mail server.
- The owner-only screens (Data protection, Send reset email) were checked by tests, not clicked through in a browser with an owner account.
- Frontend: type check and build pass. Screens were opened in a browser, including phone width.
- **Real org runs (Developer Edition org, 2026-11-12), two backups, both ended PARTIAL, never SUCCEEDED:**
  - Run 1 (full copy, ~78 min): 119,672 records across 182 objects and about 1,700 metadata items. It exposed real problems, all fixed afterwards: very wide objects (PermissionSet, Profile and others) failed on Salesforce's query-address limit, several helper objects cannot be read at all, and Settings, Lightning components and report folders were counted as "missing" because Salesforce names them differently.
  - Run 2 (incremental, ~87 min, restarted once so it shows 2 attempts): all 213 metadata types verified; the wide objects now copy through the Bulk API; 141 objects were updated incrementally (7,542 records new or changed, 0 deleted); no item was marked SUCCEEDED with a wrong count.
  - Still not clean: 11 Opportunity/Order objects failed with Salesforce's **"TotalRequests Limit exceeded"** (the org's 24-hour API request allowance, used up by the two runs), and `PermissionSetTabSetting` is PARTIAL (Salesforce counts 58,071 rows but both the Bulk API and the standard API returned only about 8,390). The cause of that gap has not been found.

## 8. Known limits (not hidden)

- **Not in this version:** file and attachment contents, and restore into Salesforce.
- Records use the REST API below `BULK_THRESHOLD_ROWS` and the Bulk API 2.0 above it. The Bulk path was used live only for objects with too many fields for the standard API (small row counts); a multi-page Bulk download of a large object has been tested against a fake server only.
- A backup uses many Salesforce API calls (a Developer org's 24-hour allowance was exhausted by two runs). Space out runs on small orgs, or the last objects will fail with "TotalRequests Limit exceeded".
- Some data is not copied, and each is listed with its reason: managed-package metadata, binary and compound fields, and some system objects. See **What a backup covers** on the org page.
- An incremental backup is a rebuilt full snapshot: it still stores a full copy of each object on disk every time, so storage use is the same as full copies. It saves Salesforce API calls and time, not disk space.
- Storage is the server's disk (`STORAGE_DIR`). The code is split so object storage (S3 or similar) can be added, but it is not built yet.
- The queue lives in PostgreSQL and the worker can run separately, but there is one database and no automatic scaling.- Email covers failure alerts, invitations, password reset and sign-up confirmation. An alert is not retried if the mail server is down at that moment (the failure is shown in the alert list). If the confirmation email cannot be sent, the account is still created and the person can ask for the link again.
- Roles: **Owner** can do everything, including settings, team, legal hold and deletion. **Admin** can connect, back up, schedule and delete orgs. **Viewer** can look, browse the data explorer and download. **Auditor** can look and browse but cannot download, export or change anything.
