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
| `GET /admin/me` | 200 for admins (custom claim `admin: true`) |
| `GET /admin/users?search=&cursor=` | Users, searched by email prefix or uid |
| `GET /admin/users/:uid` | Auth record, subscription, transactions, recent usage |
| `GET /admin/purchases?productId=&status=&environment=&from=&to=&cursor=` | All transactions |
| `GET /admin/income?granularity=day\|month&environment=&from=&to=` | Estimated revenue, subscriber counts, MRR |
| `GET /admin/config`, `PUT /admin/config/limits`, `PUT /admin/config/products` | Limits and product display settings |

### Making someone an admin

```sh
npm run set-admin -- --email someone@eazee.ai
npm run set-admin -- --email someone@eazee.ai --remove
```

This uses the same Firebase credentials as the server. The app picks up the
role the next time it opens (it refreshes the ID token).

Existing accounts appear in the admin Users list once they open the app, or
right away after:

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
