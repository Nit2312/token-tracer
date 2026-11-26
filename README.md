# Token Tracer (AgentVis)

Token Tracer (also known as AgentVis) is a comprehensive token-tracking and pair-programming analytics dashboard designed to monitor, price, and analyze LLM token usage from development agents (specifically **Claude Code** and **Cursor**).

It provides developers, administrators, and researchers with insights into code edit impact, caching efficiency, rework loops, costs, and conversation trajectories.

---

## What the Project is About

AI coding assistants like Claude Code and Cursor can consume millions of tokens in a single afternoon due to large context windows, tool outputs, and repository indexing. Token Tracer intercepts and parses local session logs and syncs them to a centralized database (Neon Postgres) to render insights through three main user interfaces:

1. **Personal Dashboard (`/dashboard`)**:
   - For individual members to track their personal stats.
   - Highlights total daily/historical token flow, lines added/removed, tool usage frequencies, and file risk profiles.
   - Allows interactive replaying of conversation trajectories, user prompts, assistant replies, and turn-by-turn token charges.

2. **Team Admin Dashboard (`/team`)**:
   - For team leaders to track developer productivity, overall costs, and tool error rates across multiple developers.
   - Summarizes total API spend, model breakdowns, and flags "workflow smells" like rework loops or excessive coding churn.

3. **Superadmin Console (`/admin`)**:
   - For global configuration, database auto-migrations, and user account provisioning.
   - Hosts custom pricing overrides ($/1M input/output/cache tokens) and synchronizes them across the platform.

---

## How It's Built: Architecture & Stack

### Frontend
- **Framework**: [Next.js](https://nextjs.org) (App Router).
- **Client Logic**: Built using **vanilla JavaScript** (`app.js`, `team/app.js`, `admin/admin.js`) for fast page loads and smooth micro-animations.
- **Styling**: Curated vanilla CSS styling (custom HSL variables, sleek dark modes, glassmorphism, responsive designs) without the overhead of TailwindCSS.
- **Visualizations**: SVG-based custom charts for daily token flow, line impacts, and punchcard hourly rhythms.

### Backend API
- **Routes**: Next.js route handlers (`app/api/...`) that orchestrate authentication, session queries, and data rollup.
- **Authentication**: JWT-based session state (`lib/auth.ts`) mapped across roles (`user`, `admin`, `superadmin`).
- **Database**: PostgreSQL (Neon Serverless Pool) using `pg`. Idempotent auto-schemas ensure migrations run automatically on server restart.

### Local Sync Daemon
- **Script**: [`public/sync-daemon.mjs`](public/sync-daemon.mjs)
- **Role**: A background service that runs on the developer's local machine. It scans local directories for session transcript JSONL files (`~/.claude/projects/` and others), sanitizes them to ensure code privacy, and pushes metadata batches to the Vercel hosted ingest API using a secure `Authorization: Bearer <key>` header.

---

## Getting Started

### Requirements

**Node.js 24.x (LTS).** The version is pinned in two places that must stay in step: `.nvmrc` (`24`) and `engines.node` in `package.json` (`24.x`). With [nvm](https://github.com/nvm-sh/nvm), run `nvm install` and `nvm use` in the project folder; it reads `.nvmrc`. npm 11 (bundled with Node 24) is expected.

- **Why 24.x:** Next.js 16.4.2 needs Node ≥ 20.9 and the strictest dependency needs ≥ 20.19 / 22.13 / 24, so 24 is compatible; Node 20 reached end-of-life on 2026-04-30; 24 is an LTS line supported until 2028-04-30 and is the version the whole codebase and its test suites have been built and verified on.
- **Vercel:** `engines.node` in `package.json` **overrides** the Node.js Version in the Vercel project settings, so deployments use the latest 24.x regardless of the dashboard. Keep it a major-only value such as `24.x` (an open range like `>=24` would auto-upgrade to a newer major on the next deploy).
- **CI:** there is no CI configuration in this repository. When one is added, use the same pin, e.g. `actions/setup-node` with `node-version-file: .nvmrc`.
- **Upgrading Node:** change `.nvmrc`, `engines.node` and the major of `@types/node` together, then run `npx tsc --noEmit`, `npm run test:unit`, `npm run build` and the database suites (`npm run test:db`) before deploying. `tests/node-version.test.ts` fails if these drift apart or if you run the tests on a different Node major.

### Local Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   Create a `.env.local` file in the project root containing:
   ```env
   DATABASE_URL=your_postgresql_url
   ADMIN_PASSWORD=your_admin_password
   SUPERADMIN_PASSWORD=your_superadmin_password
   ```

3. **Start the Next.js development server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to view the application.

4. **Verify your local Claude usage script**:
   To parse local logs on your terminal and check them against the database:
   ```bash
   node scratch/verify-claude-usage.js
   ```
