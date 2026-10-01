# eazee-server

Backend for the Eazee app: AI routing, voice, App Store subscriptions, usage
limits and the admin API.

```sh
npm install
npm run dev      # build, then watch and restart
npm test         # build, then run node --test
```

## Subscriptions, limits and admin

The Firestore data model is in [FIRESTORE.md](FIRESTORE.md).

### Endpoints

Every endpoint requires a Firebase ID token and goes through App Check (when
`APP_CHECK_REQUIRED=true`), except the Apple notification endpoint.

| Method and path | Purpose |
|---|---|
| `GET /subscriptions/apple/account-token` | StoreKit `appAccountToken` for this account |
| `POST /subscriptions/apple/verify` | Verify one signed transaction, record it, update the `eazeePro` claim |
| `POST /subscriptions/apple/sync` | The device's current entitlement, renewal info and recent transactions (up to 25) |
| `GET /subscriptions/status` | Plan, state, limits, today's usage, product display settings |
| `GET /subscriptions/history` | This account's transactions (`?cursor=` for more) |
| `POST /subscriptions/apple/notifications` | App Store Server Notifications V2. No Firebase token: Apple's signed payload is verified instead |
| `GET /admin/me` | The caller's role, for admins and super admins (custom claim `role`) |
| `GET /admin/users?search=&role=&cursor=` | Users, searched by email prefix or uid, filtered by role |
| `POST /admin/users/:uid/role` | Super admin only: `{ "role": "customer" | "admin" }` |
| `GET /admin/role-changes?cursor=` | Super admin only: the role-change audit log |
| `GET /admin/users/:uid` | Auth record, subscription, transactions, recent usage |
| `GET /admin/purchases?productId=&status=&environment=&from=&to=&cursor=` | All transactions |
| `GET /admin/income?granularity=day\|month&environment=&from=&to=` | Estimated revenue, subscriber counts, MRR |
| `GET /admin/config`, `PUT /admin/config/limits`, `PUT /admin/config/products` | Limits and product display settings |

### Roles

There are three roles, stored as the Firebase custom claim `role` and mirrored
to `users/{uid}.role`:

| Role | Can |
|---|---|
| `superAdmin` | Everything an admin can, plus change other users' roles in the admin panel |
| `admin` | Use the admin panel |
| `customer` | Use the app (everyone who signs up) |

**Super admin.** On every start the server makes sure the account in
`SUPER_ADMIN_EMAIL` exists and has the `superAdmin` role. If the account does
not exist, it is created with `SUPER_ADMIN_PASSWORD`. An existing account keeps
its password; only its role is fixed. Its uid is recorded in `config/roles`.
The password is never stored in Firestore or logged.

**Admins** are made, and made customers again, by the super admin in the
admin panel (Users > a user > Role). There is no command-line step. The super
admin role cannot be granted or removed from the app, and nobody can change
their own role, so there is always a super admin. Each change revokes the
user's refresh tokens (they sign in again to get the new role) and is recorded
in `roleChanges`.

**Existing accounts.** Run this once after deploying. It lists every account in
the admin Users list and migrates the old `admin: true` claim to
`role: "admin"`:

```sh
npm run backfill-users
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SUBSCRIPTION_ENFORCEMENT` | off | `true` enforces the Pro-only endpoints and the daily limits, and counts usage in Firestore |
| `SUBSCRIPTION_UNLIMITED_EMAILS` | `developer_sandbox@eazee.ai` | Accounts that always get Pro limits |
| `APPLE_BUNDLE_ID` | `com.eazee.ai` | Transactions for other apps are refused |
| `APP_ENV` | `production` | Set to `development` only on local servers |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | unset | The super admin account; see Roles. The password only creates a missing account |
| `APPLE_ALLOW_XCODE_TRANSACTIONS` | off | Accept Xcode's locally signed StoreKit transactions. **The server refuses to start with this on unless `APP_ENV=development`** |

The limits themselves are not environment variables. They are stored in
Firestore `config/subscription`, edited in the admin panel, and cached by the
server for 60 seconds.

### App Store Server Notifications

In App Store Connect > App Information > App Store Server Notifications, set
the Production and Sandbox URLs to
`https://<server>/subscriptions/apple/notifications` (Version 2). Renewals,
auto-renew changes, billing problems, expiry and refunds are then recorded even
when the app is not opened. Local StoreKit testing sends no notifications; the
app syncs at launch and after the manage-subscriptions sheet closes instead.

### Firestore rules and indexes

`firestore.rules` and `firestore.indexes.json` are deployed with
`firebase deploy --only firestore`. This replaces the rules in the Firebase
console, so check that nothing else relies on those first.
