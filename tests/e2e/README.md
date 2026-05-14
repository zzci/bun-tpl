# API e2e suite (live API + dex IdP, encrypted DB)

Drives the live API process against a real OIDC provider (dex) over a real
encrypted database. The test data dir lives under `tests/e2e/.cache/data/`
(per-run subdir) so it never collides with the local dev DB at
`<repo>/data/db/app.db`.

## Run

```bash
bun run test:e2e
```

The orchestrator prints a phase-by-phase summary at the end, e.g.:

```
e2e summary
  phase                                 tests   pass   fail   skip     time
  phase-a-encryption-init                   4      4      0      0    0.36s
  phase-b-modules                          42     41      0      1    2.64s
  phase-c-encryption-unlock                 6      6      0      0    0.37s
  TOTAL                                    52     51      0      1    3.37s
```

## Reports

Each run writes JUnit XML and a JSON summary into
`tests/e2e/.cache/reports/<run-ts>/`:

```
tests/e2e/.cache/reports/<run-ts>/
  phase-a-encryption-init.xml
  phase-b-modules.xml
  phase-c-encryption-unlock.xml
  summary.json
```

A `tests/e2e/.cache/reports/latest` symlink always points to the most
recent run, so CI can attach `tests/e2e/.cache/reports/latest/*.xml` as
test artefacts unconditionally. The orchestrator keeps the 10 most
recent runs and trims older ones.

Three sequential phases share one data dir:

| Phase | Test target | What it covers |
|---|---|---|
| **A. encryption init** | `modules/encryption/init.test.ts` | API boots fresh + encrypted; status `uninitialized`; the wizard derives a master keypair from a password and POSTs `/encryption/init`; the system flips inline to `unlocked`. |
| **B. module suites** | every `modules/<name>/*.test.ts` (excluding init/unlock) | Real-user simulation against the now-unlocked, OIDC-wired API: OAuth login, profile, users / groups CRUD, TOTP enrol + step-up, policy tuples + check + resource-groups, issues + comments + attachments, documents + folders + sharing + attachments, settings, audit, backup export with DEK proof, encryption admin (challenge / meta / change-master). |
| **C. encryption unlock** | `modules/encryption/unlock.test.ts` | API restart with the same DB → `locked`; the wizard fetches the unlock-challenge bundle, re-derives the master key, decrypts the wrapped DEK, re-encrypts under the server's ephemeral pubkey, POSTs `/encryption/unlock` → `unlocked` again. |

dex itself is fetched on first run (binary extracted from the official
`ghcr.io/dexidp/dex` OCI image — no docker daemon required, just curl +
python3 + tar) into `tests/e2e/.cache/dex` and reused.

## Layout

```
tests/e2e/
  run.ts                       # 3-phase orchestrator (entry point)
  scripts/install-dex.sh       # ghcr-pull-then-source-build dex installer
  dex/config.yaml              # static client + 2 static users
  lib/
    api.ts                     # cookie-jar HTTP client (multipart-aware)
    oidc.ts                    # OIDC login walker + per-email session cache
  modules/
    system/
      health.test.ts
    account/
      auth.test.ts             # OIDC login + me + logout
      me.test.ts               # /me / users / preferences / status update
      groups.test.ts           # CRUD + members
      totp.test.ts             # enrol + confirm + step-up + delete
    policy/
      tuples.test.ts           # tuple CRUD + check
      resource-groups.test.ts  # rg CRUD + check chain (editor implies viewer)
    document/
      documents.test.ts        # folders + documents + sharing
      attachments.test.ts      # multipart upload + download + delete
    issue/
      issues.test.ts           # CRUD + comments
      attachments.test.ts      # multipart upload + size cap
    settings/
      settings.test.ts         # admin K/V + 403 matrix
    audit/
      audit.test.ts            # event listing + 403 matrix
    backup/
      export.test.ts           # admin export with DEK proof
    cron/
      cron.test.ts             # actions catalog + read paths
                               # (write paths describe.skip — see Known issues
                               # in docs/develop/operations.md)
    encryption/
      init.test.ts             # phase A
      unlock.test.ts           # phase C
      admin.test.ts            # /meta + /challenge + change-master (phase B)
  .cache/                      # dex binary + per-run data dirs (gitignored)
```

## Static users (dex)

Both have password `admin`:

| Email | Role in API |
|---|---|
| `admin@example.com` | admin (matches `DEFAULT_ADMIN`) |
| `user@example.com` | regular user |

## Adding a new test

1. Drop `<area>.test.ts` under the matching `modules/<module>/` folder.
2. Use `getClient(email)` from `../../lib/oidc` to grab a cached, logged-in
   `ApiClient`. The cache self-heals (probes `/me`, re-logs in on 401).
3. The orchestrator wires `E2E_API_BASE`, `E2E_DEX_BASE`,
   `E2E_BOOTSTRAP_TOKEN`, and `E2E_PASSWORD` into the test process —
   `lib/api.ts` reads `E2E_API_BASE` so tests work whether the API is on
   the default `:3010` or somewhere else.
4. New module subdirs have to be added to `MODULE_DIRS` in `run.ts` so the
   orchestrator picks them up.

## Known gaps

- `rotate-dek` is currently `it.skip` in `encryption/admin.test.ts` — the
  WAL/lock contention between the live writer and the libsql copy client
  triggers `SQLITE_IOERR: disk I/O error` mid-rotation. Tracked
  separately; the rest of the encryption admin surface is covered.
