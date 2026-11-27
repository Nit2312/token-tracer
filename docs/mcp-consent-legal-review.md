# Token Tracer: AI-assistant connection (MCP). Summary for Legal / HR review

**Purpose of this document:** to ask Legal/HR to approve (or amend) the wording shown to administrators, and the way the feature handles employee data, before it is switched on in production. It has no technical prerequisites to read.

**Status:** not yet live. Nothing has been enabled in production. The feature is off by default and will stay off until this review is signed.

---

## 1. What this is, in plain terms

Token Tracer already records how our developers use AI coding assistants (Claude Code, Cursor and similar): how many tokens they use, what it costs, which sessions they ran, and so on. Administrators see this in the Token Tracer dashboard.

This feature lets an **administrator connect an AI assistant (for example Claude Desktop) to that same data**, so they can ask questions in plain language, such as "who on the team used the most tokens this week?" The assistant fetches the answer from Token Tracer for them.

It is **read-only**. It does not add new data collection. It gives administrators a second way to look at data we already hold.

## 2. Who can use it

- Only a Token Tracer user with the **administrator** role who belongs to a **team**. They must be signed in with their password and a second factor (authenticator app code).
- An administrator only ever sees **their own team's** data. There is no way to ask for another team's data.
- The administrator must **explicitly approve** each connection on a consent page. That page is the wording this review is about.

## 3. What the connected assistant CAN see

For the administrator's team only:

| Data | Detail |
|---|---|
| Developers | Names (display names) and role, as listed in Token Tracer |
| Daily activity per developer | Token counts, cost, number of sessions, tool calls and errors, edits, lines added and removed, files touched (a count) |
| Sessions | Start and end time, tool (for example Claude Code), model, token counts, cost, which tools were called and how often |
| Prompt **metadata** | When a prompt was sent, its length in characters, its category (bug fix, feature, refactor and so on), whether it contains a code block, a file path or an error trace, and the token counts of the reply |

History is limited: at most 14 days back for activity and sessions, and 7 days for prompt metadata.

## 4. What it CANNOT see or do

- **The text of any prompt.** Not the question a developer typed, and not any snippet of it.
- File contents or file names.
- Passwords, API keys, or login details of any user.
- Anything outside the administrator's own team.
- It cannot change, add or delete anything.

Reading the text of prompts is a separate, deliberately disabled capability. It requires a separate written approval and a separate security review before it could ever be turned on. **This document does not ask for that.**

## 5. Wording change made for this review

The consent page previously said the connection could read "prompt text with sensitive values masked". That overstated what the system does: the first release exposes prompt **metadata only**. The wording now reads:

> If you approve, it will be able to **read**:
> - your team's developers and their activity (tokens, cost, sessions)
> - session details (which tools were used and how often, edits, errors)
> - prompt metadata only: when it was sent, its length, its category (for example bug fix or refactor), and whether it contains code, a file path or an error trace
>
> It cannot read the text of any prompt, or any file contents or file names. It cannot change or delete anything. Granting and revoking access is recorded in the audit log. You can revoke access at any time.

The page also tells the administrator where the result will be sent and warns them to approve only if they started the connection themselves.

## 6. How access is controlled, recorded and ended

- **Access lifetime.** A connection's access token lasts 30 minutes and renews automatically. A connection that goes unused for 14 days stops working, and no connection lasts longer than 60 days without being approved again.
- **Automatic revocation.** All of a user's connections are cancelled when their password or authenticator is reset, their role or team changes, they are deactivated, or they are removed from the team.
- **Recorded events.** Approvals, denials, token issue and renewal, and revocations are written to the audit log. Those records are kept.
- **Not recorded: individual queries.** The system does **not** currently keep a log of each question an administrator asks through the assistant. A table for that exists but nothing writes to it yet. **Legal/HR should decide whether this is acceptable or whether per-query logging is required before launch.**
- **No self-service revoke page.** There is no screen where an administrator reviews and cancels their own connections. Revocation happens through the automatic triggers above, or by a platform owner running a database command. **Legal/HR may want a self-service screen as a condition.**

## 7. Points that need a Legal/HR decision

1. **Employee notice.** Are developers already told, in policy or contract, that their AI-assistant usage is monitored at this level of detail (tokens, cost, sessions, prompt categories)? Does the notice cover administrators using an AI assistant to analyse it?
2. **Data leaves Token Tracer.** When an administrator connects an assistant such as Claude, the results of their questions (including developers' names and usage figures) are processed by that assistant's provider, under the administrator's own account and terms. Is that covered by our agreements with that provider and by our data-protection basis?
3. **Prompt categories.** The category (bug fix, refactor and so on) is derived from the content of the prompt, even though the content itself is never shown. Is that acceptable as "metadata"?
4. **Logging gap and revoke screen** (section 6).
5. **Retention.** Authorization records are cleaned up automatically, and audit records are kept. Confirm the retention period for audit records is acceptable.
6. **Wording.** Approve the consent text in section 5, or send amendments. The text lives in `app/oauth/authorize/consent-form.tsx`.

## 8. Sign-off

| | |
|---|---|
| Approved as written | ☐ |
| Approved with amendments (attach) | ☐ |
| Not approved | ☐ |
| Name / role | |
| Date | |
| Signature | |
