# Zimbra Multi-Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each app user to connect multiple Zimbra mailboxes, persist the last-switched active account in the database, and switch accounts from Connected Apps + Email header.

**Architecture:** Replace 1:1 `nik` PK on `DT_MAILBOX_CREDENTIAL` with UUID rows + `@@unique([nik, zimbraEmail])`. Store `DT_USER.activeZimbraEmail`. All mailbox SOAP calls resolve credentials via active email (optional `?account=` override). Frontend lists accounts, switches via `PUT /active`, and scopes React Query by `activeEmail`.

**Tech Stack:** NestJS, Prisma (SQL Server), Next.js, React Query, Axios. Spec: `docs/superpowers/specs/2026-10-08-zimbra-multi-account-design.md`.

**Repos:** Backend `/Users/fakhriaziz/Coding/TASK-MANAGER`, frontend `/Users/fakhriaziz/Coding/task-manager-fe`.

---

## File map

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | Multi-row credentials + `activeZimbraEmail` |
| `prisma/sql/mailbox_multi_account.sql` | SQL Server migration + backfill |
| `src/mailbox/mailbox-active.util.ts` | Pure fallback: newest remaining by `createdAt` |
| `src/mailbox/mailbox-active.util.spec.ts` | Unit tests for fallback |
| `src/mailbox/dto/mailbox.dto.ts` | `SetActiveMailboxDto`; disconnect query email |
| `src/mailbox/mailbox.service.ts` | Status/connect/disconnect/setActive + `withAuth` resolve |
| `src/mailbox/mailbox.controller.ts` | Routes: status shape, `DELETE ?email=`, `PUT active` |
| `task-manager-fe/.../mailboxTypes.ts` | `MailboxStatus` with `accounts` + `activeEmail` |
| `task-manager-fe/.../mailboxService.ts` | Client: disconnect(email), setActive, status |
| `task-manager-fe/.../mailboxAction.ts` | Hooks + query keys scoped by active email |
| `task-manager-fe/.../ZimbraConnectionCard.tsx` | Multi-account Connected Apps UI |
| `task-manager-fe/.../email/page.tsx` | Header account switcher |

---

### Task 1: Schema + SQL migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/sql/mailbox_multi_account.sql`

- [ ] **Step 1: Update Prisma models**

In `DT_USER`:
```prisma
activeZimbraEmail String? @db.NVarChar(255)
mailboxCredentials DT_MAILBOX_CREDENTIAL[]
```
Remove `mailboxCredential DT_MAILBOX_CREDENTIAL?`.

Replace `DT_MAILBOX_CREDENTIAL` with:
```prisma
model DT_MAILBOX_CREDENTIAL {
  id                 String    @id @db.VarChar(36)
  nik                String    @db.Char(8)
  zimbraEmail        String    @db.NVarChar(255)
  passwordCipher     String    @db.NVarChar(Max)
  passwordIv         String    @db.VarChar(64)
  passwordTag        String    @db.VarChar(64)
  authToken          String?   @db.NVarChar(Max)
  authTokenExpiresAt DateTime?
  updatedAt          DateTime  @updatedAt
  createdAt          DateTime  @default(now())

  user DT_USER @relation(fields: [nik], references: [nik], onDelete: Cascade, onUpdate: NoAction)

  @@unique([nik, zimbraEmail])
  @@index([nik])
}
```

- [ ] **Step 2: Write SQL migration**

Create `prisma/sql/mailbox_multi_account.sql`:
```sql
-- Multi-account mailbox: UUID PK + activeZimbraEmail on DT_USER
-- Run against SQL Server after backup.

-- 1) User.activeZimbraEmail
IF COL_LENGTH('dbo.DT_USER', 'activeZimbraEmail') IS NULL
BEGIN
  ALTER TABLE dbo.DT_USER ADD activeZimbraEmail NVARCHAR(255) NULL;
END
GO

-- 2) Add id column if missing
IF COL_LENGTH('dbo.DT_MAILBOX_CREDENTIAL', 'id') IS NULL
BEGIN
  ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL ADD id VARCHAR(36) NULL;
END
GO

-- 3) Backfill ids
UPDATE dbo.DT_MAILBOX_CREDENTIAL
SET id = LOWER(CONVERT(VARCHAR(36), NEWID()))
WHERE id IS NULL;
GO

-- 4) Backfill active from existing single credential
UPDATE u
SET u.activeZimbraEmail = c.zimbraEmail
FROM dbo.DT_USER u
INNER JOIN dbo.DT_MAILBOX_CREDENTIAL c ON c.nik = u.nik
WHERE u.activeZimbraEmail IS NULL;
GO

-- 5) Drop old PK (name may vary — inspect if fails)
DECLARE @pk NVARCHAR(200);
SELECT @pk = kc.name
FROM sys.key_constraints kc
WHERE kc.parent_object_id = OBJECT_ID('dbo.DT_MAILBOX_CREDENTIAL') AND kc.type = 'PK';
IF @pk IS NOT NULL
  EXEC('ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL DROP CONSTRAINT [' + @pk + ']');
GO

ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL ALTER COLUMN id VARCHAR(36) NOT NULL;
GO

ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL ADD CONSTRAINT PK_DT_MAILBOX_CREDENTIAL PRIMARY KEY (id);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'UQ_DT_MAILBOX_CREDENTIAL_nik_email'
    AND object_id = OBJECT_ID('dbo.DT_MAILBOX_CREDENTIAL')
)
BEGIN
  ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL
    ADD CONSTRAINT UQ_DT_MAILBOX_CREDENTIAL_nik_email UNIQUE (nik, zimbraEmail);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_DT_MAILBOX_CREDENTIAL_nik'
    AND object_id = OBJECT_ID('dbo.DT_MAILBOX_CREDENTIAL')
)
BEGIN
  CREATE INDEX IX_DT_MAILBOX_CREDENTIAL_nik ON dbo.DT_MAILBOX_CREDENTIAL(nik);
END
GO
```

- [ ] **Step 3: Regenerate Prisma client**

Run (backend repo):
```bash
pnpm exec prisma generate
```
Expected: client generates without error.

- [ ] **Step 4: Apply SQL on local DB** (operator step — use your SQL client / `sqlcmd` against `DATABASE_URL`)

- [ ] **Step 5: Commit backend schema**

```bash
cd /Users/fakhriaziz/Coding/TASK-MANAGER
git add prisma/schema.prisma prisma/sql/mailbox_multi_account.sql
git commit -m "$(cat <<'EOF'
feat(mailbox): schema for multiple Zimbra credentials per user

EOF
)"
```

---

### Task 2: Active-fallback helper (TDD)

**Files:**
- Create: `src/mailbox/mailbox-active.util.ts`
- Create: `src/mailbox/mailbox-active.util.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { pickActiveAfterDisconnect } from './mailbox-active.util';

describe('pickActiveAfterDisconnect', () => {
  const t = (email: string, createdAt: string) => ({
    zimbraEmail: email,
    createdAt: new Date(createdAt),
  });

  it('returns null when no remaining accounts', () => {
    expect(pickActiveAfterDisconnect([])).toBeNull();
  });

  it('returns the only remaining account', () => {
    expect(pickActiveAfterDisconnect([t('a@x.com', '2026-01-01')])).toBe('a@x.com');
  });

  it('returns newest by createdAt among remaining', () => {
    expect(
      pickActiveAfterDisconnect([
        t('old@x.com', '2026-01-01T00:00:00Z'),
        t('new@x.com', '2026-06-01T00:00:00Z'),
        t('mid@x.com', '2026-03-01T00:00:00Z'),
      ]),
    ).toBe('new@x.com');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/fakhriaziz/Coding/TASK-MANAGER
pnpm exec jest src/mailbox/mailbox-active.util.spec.ts --no-cache
```
Expected: FAIL (module not found / cannot find pickActiveAfterDisconnect)

- [ ] **Step 3: Implement helper**

```typescript
export type MailboxAccountRow = {
  zimbraEmail: string;
  createdAt: Date;
};

/** After deleting the active account: newest remaining by createdAt, or null. */
export function pickActiveAfterDisconnect(
  remaining: MailboxAccountRow[],
): string | null {
  if (!remaining.length) return null;
  const sorted = [...remaining].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return sorted[0].zimbraEmail;
}

export function normalizeMailboxEmail(email: string): string {
  return email.trim().toLowerCase();
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm exec jest src/mailbox/mailbox-active.util.spec.ts --no-cache
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mailbox/mailbox-active.util.ts src/mailbox/mailbox-active.util.spec.ts
git commit -m "$(cat <<'EOF'
feat(mailbox): active account fallback helper after disconnect

EOF
)"
```

---

### Task 3: Backend status / connect / disconnect / setActive

**Files:**
- Modify: `src/mailbox/dto/mailbox.dto.ts`
- Modify: `src/mailbox/mailbox.service.ts` (getStatus, connect, disconnect; add setActive)
- Modify: `src/mailbox/mailbox.controller.ts`

- [ ] **Step 1: Add DTO**

```typescript
export class SetActiveMailboxDto {
  @IsEmail()
  email: string;
}
```

Export from dto file; import in controller.

- [ ] **Step 2: Rewrite `getStatus`**

```typescript
async getStatus(nik: string) {
  const rows = await this.prisma.dT_MAILBOX_CREDENTIAL.findMany({
    where: { nik },
    orderBy: { createdAt: 'desc' },
    select: { zimbraEmail: true, createdAt: true, updatedAt: true },
  });
  const user = await this.prisma.dT_USER.findUnique({
    where: { nik },
    select: { activeZimbraEmail: true },
  });
  const accounts = rows.map((r) => ({
    email: r.zimbraEmail,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
  let activeEmail = user?.activeZimbraEmail ?? null;
  if (activeEmail && !accounts.some((a) => a.email === activeEmail)) {
    activeEmail = pickActiveAfterDisconnect(
      rows.map((r) => ({ zimbraEmail: r.zimbraEmail, createdAt: r.createdAt })),
    );
    await this.prisma.dT_USER.update({
      where: { nik },
      data: { activeZimbraEmail: activeEmail },
    });
  }
  if (!activeEmail && accounts.length) {
    activeEmail = accounts[0].email; // newest (query desc)
    await this.prisma.dT_USER.update({
      where: { nik },
      data: { activeZimbraEmail: activeEmail },
    });
  }
  return {
    connected: accounts.length > 0,
    activeEmail,
    email: activeEmail, // compat
    accounts,
    updatedAt: accounts[0]?.updatedAt ?? null,
  };
}
```

- [ ] **Step 3: Rewrite `connect` to upsert by (nik, email)**

Use `randomUUID()` for new `id`. Upsert:
```typescript
where: { nik_zimbraEmail: { nik, zimbraEmail: email } },
create: { id: randomUUID(), nik, zimbraEmail: email, ...enc, authToken, authTokenExpiresAt },
update: { passwordCipher, passwordIv, passwordTag, authToken, authTokenExpiresAt },
```
Then:
```typescript
await this.prisma.dT_USER.update({
  where: { nik },
  data: { activeZimbraEmail: email },
});
return { connected: true, email, activeEmail: email };
```

- [ ] **Step 4: Rewrite `disconnect(nik, email: string)`**

- Normalize email; `deleteMany` where `{ nik, zimbraEmail: email }` (or findFirst + delete).
- If no row deleted → `BadRequestException('Akun tidak ditemukan')`.
- Load user active; if active === email (or null), set active via `pickActiveAfterDisconnect(remaining)`.
- Return `getStatus(nik)`.

- [ ] **Step 5: Add `setActive(nik, email)`**

- Require credential exists; else 400.
- Update `activeZimbraEmail`; return `getStatus(nik)`.

- [ ] **Step 6: Wire controller**

```typescript
@Delete('connect')
async disconnect(
  @Req() req: Request & { user?: AuthUser },
  @Query('email') email?: string,
) {
  if (!email?.trim()) {
    throw new BadRequestException('Query email wajib');
  }
  const data = await this.mailbox.disconnect(req.user!.nik, email);
  return new CommonResponse('Mailbox disconnected', HttpStatus.OK, data);
}

@Put('active')
async setActive(
  @Req() req: Request & { user?: AuthUser },
  @Body() dto: SetActiveMailboxDto,
) {
  const data = await this.mailbox.setActive(req.user!.nik, dto.email);
  return new CommonResponse('Active mailbox updated', HttpStatus.OK, data);
}
```

Import `Put`, `BadRequestException`, `SetActiveMailboxDto`.

- [ ] **Step 7: Smoke with curl** (logged-in cookie/token)

```bash
# status → accounts[]
# connect second email → accounts length 2, activeEmail = new
# PUT /api/mailbox/active { "email": "first@..." }
# DELETE /api/mailbox/connect?email=second@...
```

- [ ] **Step 8: Commit**

```bash
git add src/mailbox/dto/mailbox.dto.ts src/mailbox/mailbox.service.ts src/mailbox/mailbox.controller.ts
git commit -m "$(cat <<'EOF'
feat(mailbox): multi-account connect, disconnect, and set active

EOF
)"
```

---

### Task 4: Backend `withAuth` resolves active account

**Files:**
- Modify: `src/mailbox/mailbox.service.ts`

- [ ] **Step 1: Add private `resolveCredential(nik, accountEmail?: string)`**

```typescript
private async resolveCredential(nik: string, accountEmail?: string) {
  const user = await this.prisma.dT_USER.findUnique({
    where: { nik },
    select: { activeZimbraEmail: true },
  });
  const email =
    normalizeMailboxEmail(accountEmail || user?.activeZimbraEmail || '') || null;
  if (!email) {
    throw new BadRequestException('Mailbox belum terhubung. Hubungkan akun Zimbra dulu.');
  }
  const cred = await this.prisma.dT_MAILBOX_CREDENTIAL.findUnique({
    where: { nik_zimbraEmail: { nik, zimbraEmail: email } },
  });
  if (!cred) {
    throw new BadRequestException('Mailbox belum terhubung. Hubungkan akun Zimbra dulu.');
  }
  return cred;
}
```

- [ ] **Step 2: Change `withAuth` signature**

```typescript
private async withAuth<T>(
  nik: string,
  fn: (token: string, cred: { nik: string; zimbraEmail: string; /* ... */ }) => Promise<T>,
  accountEmail?: string,
): Promise<T>
```

- Load via `resolveCredential`.
- On refresh, `update({ where: { id: cred.id }, data: { authToken, authTokenExpiresAt } })`.
- Pass `cred` into `fn` if needed; existing call sites can ignore second arg: `withAuth(nik, (token) => ...)`.

- [ ] **Step 3: Thread optional `account` from controller query into service methods that call `withAuth`**

Minimal path for v1: **do not** add `?account=` on every route yet — always use DB active. Spec allows override later. Skip query override unless needed for tests.

- [ ] **Step 4: Restart `pnpm run start:dev` and open Email with two accounts; switch active; folders must change**

- [ ] **Step 5: Commit**

```bash
git add src/mailbox/mailbox.service.ts
git commit -m "$(cat <<'EOF'
feat(mailbox): resolve Zimbra auth via active account credential

EOF
)"
```

---

### Task 5: Frontend types + API client + hooks

**Files (task-manager-fe):**
- Modify: `src/lib/mailbox/mailboxTypes.ts`
- Modify: `src/lib/mailbox/mailboxService.ts`
- Modify: `src/lib/mailbox/mailboxAction.ts`

- [ ] **Step 1: Types**

```typescript
export type MailboxAccount = {
  email: string;
  createdAt: string;
  updatedAt: string;
};

export type MailboxStatus = {
  connected: boolean;
  email: string | null; // compat = activeEmail
  activeEmail: string | null;
  accounts: MailboxAccount[];
  updatedAt: string | null;
};
```

- [ ] **Step 2: Service methods**

```typescript
disconnect: async (email: string) => {
  const { data } = await axiosInstance.delete(`${base}/connect`, {
    params: { email },
  });
  return assertOk(data);
},

setActive: async (email: string) => {
  const { data } = await axiosInstance.put(`${base}/active`, { email });
  return assertOk(data);
},
```

- [ ] **Step 3: Hooks**

```typescript
export function useMailboxSetActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => MailboxService.setActive(email),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mailbox'] });
    },
  });
}
```

Change `useMailboxDisconnect` to `mutationFn: (email: string) => MailboxService.disconnect(email)`.

Scope list/message query keys with active email when available:
```typescript
queryKey: ['mailbox', 'folders', activeEmail],
```
Pass `activeEmail` from `useMailboxStatus().data?.activeEmail` into folder/message hooks (add optional param).

- [ ] **Step 4: Commit FE**

```bash
cd /Users/fakhriaziz/Coding/task-manager-fe
git add src/lib/mailbox/mailboxTypes.ts src/lib/mailbox/mailboxService.ts src/lib/mailbox/mailboxAction.ts
git commit -m "$(cat <<'EOF'
feat(email): mailbox client support for multi-account status and switch

EOF
)"
```

---

### Task 6: Connected Apps UI — list / add / disconnect / set active

**Files:**
- Modify: `src/app/dashboard/user-settings/components/ZimbraConnectionCard.tsx`

- [ ] **Step 1: Render `statusQ.data.accounts` as rows**

Each row: email, badge if `email === activeEmail`, button “Jadikan aktif” (if not active), button Disconnect calling `disconnect.mutateAsync(email)`.

- [ ] **Step 2: Keep connect form as “Tambah akun”**

After success, form clears; list refreshes via invalidate.

- [ ] **Step 3: Manual check**

Open `/dashboard/user-settings#connected-apps` — connect 2 accounts, switch active, disconnect non-active then active; verify fallback.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/user-settings/components/ZimbraConnectionCard.tsx
git commit -m "$(cat <<'EOF'
feat(settings): multi Zimbra accounts in Connected Apps

EOF
)"
```

---

### Task 7: Email header account switcher

**Files:**
- Modify: `src/app/dashboard/email/page.tsx`

- [ ] **Step 1: Use `activeEmail = status?.activeEmail || status?.email`**

Replace display `status?.email` with `activeEmail`.

- [ ] **Step 2: Dropdown menu items for each account**

```tsx
{(status?.accounts || []).map((a) => (
  <DropdownMenuItem
    key={a.email}
    disabled={a.email === activeEmail}
    onClick={async () => {
      try {
        await setActive.mutateAsync(a.email);
        toast.success(`Aktif: ${a.email}`);
      } catch (err) {
        toast.error((err as Error).message);
      }
    }}
  >
    {a.email}
    {a.email === activeEmail ? ' · Aktif' : ''}
  </DropdownMenuItem>
))}
```

Disconnect item: `disconnect.mutateAsync(activeEmail!)` (guard if null).

- [ ] **Step 3: On active change, clear `selectedId` / folder selection as needed and refetch**

`setSelectedId(null)` in setActive onSuccess path (page-level).

- [ ] **Step 4: Manual check**

Two accounts with different unread — switch header → inbox contents change; refresh page → same active persists (DB).

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/email/page.tsx
git commit -m "$(cat <<'EOF'
feat(email): switch active Zimbra account from header

EOF
)"
```

---

### Task 8: Final verification + push

- [ ] **Step 1: Backend checklist**

- [ ] Migration applied on local SQL Server  
- [ ] `pnpm exec jest src/mailbox/mailbox-active.util.spec.ts` PASS  
- [ ] Connect A, B → status.accounts length 2, active B  
- [ ] PUT active A → folders for A  
- [ ] DELETE connect?email=A with B,C left → active = newest of B,C  

- [ ] **Step 2: Frontend checklist**

- [ ] Connected Apps shows both + Aktif badge  
- [ ] Header switcher works after reload  
- [ ] Disconnect last account → redirect to Connected Apps  

- [ ] **Step 3: Push both repos** (only when user asks, or if they already said push — here ask first unless continuing from “commit push” habit; this plan ends with local commits)

```bash
# only if user requests push:
# git -C TASK-MANAGER push origin HEAD
# git -C task-manager-fe push origin HEAD
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Multi credential `@@unique([nik,zimbraEmail])` + UUID id | Task 1 |
| `activeZimbraEmail` on user + backfill | Task 1 |
| GET status accounts + activeEmail | Task 3 |
| POST connect upsert, set active | Task 3 |
| DELETE connect?email= + newest remaining fallback | Task 2 + 3 |
| PUT active | Task 3 |
| withAuth uses active credential | Task 4 |
| FE types/client/hooks | Task 5 |
| Connected Apps list/add/disconnect/set active | Task 6 |
| Email header switcher + persistence | Task 7 |
| No merged inbox / Dropbox path change | Non-goals (skipped) |
| Optional `?account=` override | Deferred (Task 4 notes); active DB is enough for v1 |

## Type consistency

- Status fields: `connected`, `activeEmail`, `email` (compat), `accounts[]` with `email`, `createdAt`, `updatedAt`.
- Disconnect always requires email (query + FE arg).
- Prisma unique name: `nik_zimbraEmail` (Prisma default for `@@unique([nik, zimbraEmail])`).
