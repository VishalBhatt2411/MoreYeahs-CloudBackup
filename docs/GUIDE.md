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

**The first account ever created on a fresh install is the platform admin automatically.** Open http://localhost:5173/register and create your account. You will see **Salesforce integration** in the menu. Every account after that is a normal customer.

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

Then in CloudBackup: **Salesforce integration** → paste both → **Save** → **Test with Salesforce**.

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

### What the run status means

- **Succeeded**: every item was copied, re-read, and the checksum matched.
- **Partial**: some items failed or were skipped. The reason is shown on each item.
- **Failed**: nothing usable was saved.

## 5. Customers' orgs (hosted use)

The one shared Connected App must be usable in each customer org. Salesforce may require the customer's admin to allow it: **Setup → Connected Apps OAuth Usage** (or install it). If login says the app is blocked, this is why. For wide public use, Salesforce may also want a managed package or a reviewed Connected App. Check Salesforce's current rules before you launch.

## 6. Going live (hosting)

- Needs a PostgreSQL database and a server that can run Node.
- Set these environment variables on the server: `DATABASE_URL`, `APP_URL` (your https address), `JWT_SECRET` (long random), `TOKEN_ENCRYPTION_KEY` (64 hex characters), `STORAGE_DIR` (a disk that is kept and backed up).
- `npm run build`, `npm run db:migrate`, `npm start`. The server also serves the website.
- Keep `TOKEN_ENCRYPTION_KEY`. If you lose it, stored Salesforce logins cannot be read and customers must reconnect.
- Use HTTPS. Backups hold customer data, so back up `STORAGE_DIR` too.

## 7. Checks that were done

- Backend: 35 automated tests pass (login, encryption, connect flow, backup, honest status). They use a **fake Salesforce**.
- Frontend: type check and build pass. Screens were opened in a browser, including phone width.
- Against real Salesforce: the app was tested only with a fake Client ID. Salesforce answered that it does not recognise it, and the app showed a clear message. **A full backup of a real org has not been run yet.** It needs your Connected App. Please run a first backup on your Developer org and read the run details.

## 8. Known limits (not hidden)

- **Not in this version:** file and attachment contents, and restore into Salesforce.
- Records are exported with the REST API. Very large objects (millions of rows) will be slow. Bulk API 2.0 is the next step for scale.
- Some data is not copied, and each is listed with its reason: managed-package metadata, binary and compound fields, and some system objects. See **What a backup covers** on the org page.
- Backups run inside the app server process. For many customers, move them to a separate worker later.
- Storage is the server's disk. Object storage (S3 or similar) is a later step.
- No email sending (password reset, alerts) yet.
- Roles: Owner and Admin can connect, back up, schedule and delete. Viewer can only look.
