# MoreYeahs CloudBackup

Hosted, multi-tenant backup of Salesforce orgs: metadata and record data. Read-only toward Salesforce.

Stack: Express + TypeScript + Prisma/PostgreSQL (backend), React + Vite (frontend).

Quick start:

```bash
npm install
npm run setup
npm run db:start
npm run db:migrate
npm run dev
```

Full steps (Connected App, platform admin, going live, limits): see [docs/GUIDE.md](docs/GUIDE.md).
