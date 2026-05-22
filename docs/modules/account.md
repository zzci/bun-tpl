# Account Module

The account module owns authentication, sessions, users, groups, user preferences, and TOTP.

Code layout:

```text
apps/api/src/modules/account/
  account.routes.ts            # aggregator: mounts auth + users + groups
  account.backup.ts            # one BackupContribution for users + groups + preferences
  index.ts                     # registers backup contribution + OAuth auth provider
  auth/
    auth.routes.ts
    auth.service.ts            # session lookup, refresh, default-admin promotion
    oidc.ts                    # OIDC client (oauth4webapi)
    session-cookie.ts          # cookie name + parse / write helpers
    schema.ts                  # `sessions` table
    index.ts
  users/
    schema.ts                  # `users`, `user_preferences`, `user_totp_devices`
    users.routes.ts
    users.service.ts
    totp.service.ts
    index.ts
  groups/
    schema.ts                  # `groups` + `group_members`
    groups.routes.ts
    groups.service.ts          # group CRUD; delegates membership writes
    group-members.service.ts   # owns user ↔ group and nested group ↔ group edges
    index.ts
```

## Authentication

Authentication uses an external OAuth/OIDC provider with authorization code flow and PKCE.

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/auth/mode` | Public | Reports the active login mode (`oauth` or `single-user`) so the SPA picks the right login form. |
| GET | `/api/account/auth/login` | Public | Starts OAuth login. |
| GET | `/api/account/auth/callback` | Public | Handles OAuth callback and creates a local session. |
| POST | `/api/account/auth/login-local` | Public | Single-user login with `username` + `password`. Active only when `SINGLE_USER_MODE=true`. |
| POST | `/api/account/auth/logout` | Authenticated | Deletes the local session. |
| GET | `/api/account/auth/logout-url` | Public | Returns the configured upstream logout URL. |
| POST | `/api/account/auth/totp/verify` | Public | Completes login-time TOTP verification. |

The callback creates or updates a local user record based on OAuth userinfo. OAuth/OIDC provider settings are read from environment variables at runtime, not from editable database settings. `DEFAULT_ADMIN` is only used while the users table is empty: the first matching login becomes admin, and existing users are never promoted by this value.

## Current User

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/me` | Authenticated | Current user profile and groups. |
| GET | `/api/account/me/groups` | Authenticated | Current user's groups. |
| GET | `/api/account/me/preferences/:key` | Authenticated | Reads one preference. |
| PUT | `/api/account/me/preferences/:key` | Authenticated | Writes one preference. |
| GET | `/api/account/me/totp` | Authenticated | Lists TOTP devices. |
| POST | `/api/account/me/totp` | Authenticated | Creates a TOTP setup. |
| POST | `/api/account/me/totp/:deviceId/confirm` | Authenticated | Confirms a TOTP setup. |
| DELETE | `/api/account/me/totp/:deviceId` | Authenticated | Deletes a TOTP device. |
| POST | `/api/account/me/totp/verify` | Authenticated | Verifies a TOTP code for step-up operations. |

## Users

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/visible-users` | Authenticated | Active user directory exposed to every signed-in caller, for assignment and sharing pickers. |
| GET | `/api/account/users` | Admin | User list. |
| GET | `/api/account/users/:id` | Admin | User detail. |
| PATCH | `/api/account/users/:id` | Admin | Updates role, status, or profile fields. |
| GET | `/api/account/users/:id/groups` | Admin | User group membership. |

## Groups

Implemented routes:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/account/groups` | Admin | Group list. |
| POST | `/api/account/groups` | Admin | Creates a group. |
| GET | `/api/account/groups/:id` | Admin | Group detail. |
| PATCH | `/api/account/groups/:id` | Admin | Updates a group. |
| DELETE | `/api/account/groups/:id` | Admin | Deletes a group. |
| GET | `/api/account/groups/:id/members` | Admin | Group members. |
| POST | `/api/account/groups/:id/members` | Admin | Adds a member. |
| DELETE | `/api/account/groups/:id/members/:userId` | Admin | Removes a member. |

## Policy Integration

Users and groups are policy subjects. Resource grants to users and to groups
are stored in `relation_tuples`, but group **membership** lives in the
account-owned `group_members` table — this lets a deployment drop the policy
module while keeping user-group features:

```text
document:doc123#viewer@user:user123              # in relation_tuples
document:doc123#viewer@group:group123#member     # in relation_tuples
group:group123#member@user:user123               # in group_members
group:parent-team#member@group:child-team#member # in group_members (nested)
```

The Zanzibar engine routes reads on `group:*#member` through
`group-members.service` so the two stores never disagree. The generic
`POST /api/policy/tuples` endpoint rejects writes to `group:*#member`;
callers must use `POST /api/account/groups/:id/members` instead.

Policy helper routes for account subjects live in the policy route module:

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/policy/users/:id/access` | Admin | Tuples where the user is the subject. |
| GET | `/api/policy/groups/:id/access` | Admin | Tuples where the group is the subject. |
