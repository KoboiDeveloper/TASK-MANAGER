# Zimbra multi-account — design

**Date:** 2026-10-08  
**Status:** Approved for implementation (pending user review of this doc)  
**Repos:** TASK-MANAGER (API) + task-manager-fe (UI)

## Problem

Connected Apps / mailbox today stores **one** Zimbra credential per app user (`nik` is PK on `DT_MAILBOX_CREDENTIAL`). Connecting another email overwrites the previous account. Users need multiple Zimbra mailboxes and a persisted “active” account for the Email UI.

## Goals

- One app user can connect **many** Zimbra accounts.
- Email UI uses a single **active** account at a time (header switcher).
- Last switched account is stored in the **database** (not only localStorage).
- Disconnect of the active account picks a sensible fallback among remaining accounts.

## Non-goals

- Merged inbox across accounts.
- Per-account Dropbox path isolation (uploads stay under `mailbox/${nik}/...`).
- Reordering accounts in Connected Apps beyond `createdAt`.

## Decisions (from brainstorm)

| Topic | Decision |
|--------|----------|
| Approach | A — composite uniqueness `(nik, zimbraEmail)` + `activeZimbraEmail` on `DT_USER` |
| Active account | Last account user switched to; persisted in DB |
| New connect | New/updated account becomes active |
| Disconnect active, 1 left | Remaining account becomes active |
| Disconnect active, 2+ left | Among remaining, **newest** by `createdAt DESC` becomes active |
| Disconnect non-active | Active unchanged |
| Disconnect last account | `activeZimbraEmail = null`; Email treats as disconnected |

## Data model

### `DT_MAILBOX_CREDENTIAL`

- Replace `@id` on `nik` with `id String @id @db.VarChar(36)` (UUID generated in app on create — reliable on SQL Server).
- Keep `nik` FK to `DT_USER` (`Char(8)`).
- Add `@@unique([nik, zimbraEmail])`.
- Add `@@index([nik])`.
- Keep: `passwordCipher`, `passwordIv`, `passwordTag`, `authToken`, `authTokenExpiresAt`, `createdAt`, `updatedAt`.

### `DT_USER`

- Change `mailboxCredential DT_MAILBOX_CREDENTIAL?` → `mailboxCredentials DT_MAILBOX_CREDENTIAL[]`.
- Add `activeZimbraEmail String? @db.NVarChar(255)`.

### Migration

1. Add `id` column + populate UUIDs for existing rows.
2. Drop PK on `nik`; add PK on `id`; add unique `(nik, zimbraEmail)`.
3. Add `DT_USER.activeZimbraEmail`.
4. Backfill: for each existing credential, set `user.activeZimbraEmail = credential.zimbraEmail`.

SQL Server: use a sequenced migration script under `prisma/sql/` if Prisma migrate is constrained; keep Prisma schema as source of truth for the app.

## API

Base path remains `/api/mailbox`. Auth: existing `AuthGuard` + `nik` from JWT.

### `GET /status`

```json
{
  "connected": true,
  "activeEmail": "a@amscorp.co.id",
  "accounts": [
    { "email": "a@amscorp.co.id", "createdAt": "...", "updatedAt": "..." },
    { "email": "b@amscorp.co.id", "createdAt": "...", "updatedAt": "..." }
  ]
}
```

- `connected` = `accounts.length > 0`.
- Compat: optional `email` mirror of `activeEmail` for older FE during rollout.

### `POST /connect` `{ email, password }`

- Auth against Zimbra; upsert credential by `(nik, email)`.
- Set `activeZimbraEmail = email`.
- Does **not** delete other credentials.

### `DELETE /connect?email=`

- Delete that credential for `nik`.
- If deleted email === `activeZimbraEmail`:
  - Remaining ordered `createdAt DESC` → set active to first, or `null` if none.

### `PUT /active` `{ email }`

- Require credential exists for `(nik, email)`.
- Set `activeZimbraEmail = email`.

### Mail operations (folders, messages, send, draft, attachments, …)

- Resolve credential via `nik` + active email (default).
- Optional query `?account=` (normalized email) to override for a single request; must belong to `nik`.
- Refactor `withAuth(nik, zimbraEmail?)` / `refreshAuth` to update by credential `id` or `(nik, zimbraEmail)`.

## Frontend

### Types / client

- Extend `MailboxStatus` with `accounts` + `activeEmail`.
- `MailboxService`: `setActive(email)`, `disconnect(email)`, pass `account` when needed.
- React Query keys: `['mailbox', activeEmail, ...]` so switching clears/refetches the right cache.

### Connected Apps — `ZimbraConnectionCard`

- List all accounts; badge **Aktif** on `activeEmail`.
- **Tambah akun** form (same email/password fields).
- Per-row **Disconnect**; optional per-row **Jadikan aktif**.
- Empty state: connect first account (current UX).

### Email page

- Gate: `connected` if any account.
- Header dropdown: list accounts → call `PUT /active` → invalidate mailbox queries; show active email; disconnect current still available.
- `myEmail` = `activeEmail` for reply-all “me” logic.

### Persistence note

- Source of truth for active is DB. Optional `localStorage` cache is OK only as optimistic UI, must reconcile from `GET /status`.

## Fallback algorithm (disconnect active)

```
remaining = credentials for nik except deleted, orderBy createdAt DESC
if remaining empty → active = null
else → active = remaining[0].zimbraEmail   // newest remaining
```

(Covers “2 accounts → the other one” and “>2 → newest among remaining”.)

## Test plan

- Connect account A → active = A.
- Connect account B → both listed, active = B.
- Switch to A via `PUT /active` → Email shows A’s folders after refetch.
- Disconnect B while A active → A still active.
- Disconnect A (active) with B,C present → active = newer of B,C by `createdAt`.
- Disconnect last account → status `connected: false`, Email redirects to Connected Apps.
- Reconnect same email after disconnect → upsert, becomes active again.

## Risks

- Existing FE assumes singular `email` / `disconnect()` with no args — ship FE + API together or keep compat fields briefly.
- Prisma SQL Server UUID defaults — verify `@default(uuid())` or generate in app on create.
- In-flight uploads tied to sessions: switching account mid-compose should keep session on the account that started the draft (compose session stores snapshot; do not silently change account under an open composer without user action).
