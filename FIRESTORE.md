# Firestore data model

Only this server writes these documents, using the Admin SDK. `firestore.rules`
denies every client write. Clients may read their own documents, and admins
(custom claim `admin: true`) may read everything. The app itself reads all of
this through the server's endpoints, not directly.

All times are epoch milliseconds. Prices are kept in milliunits, as Apple
reports them: `9990` means 9.99 in `currency`.

## `users/{uid}`

Created the first time an account calls `GET /subscriptions/status` (the app
does this at launch), or by `npm run backfill-users` for existing accounts.

| Field | Meaning |
|---|---|
| `email`, `emailLower`, `displayName` | From Firebase Auth. `emailLower` is used for the admin search (prefix match). |
| `providers` | Sign-in providers, e.g. `apple.com`, `google.com`, `password`. |
| `authCreatedAt` | When the Firebase account was created. |
| `appAccountToken` | The StoreKit `appAccountToken` for this account. App Store notifications are matched to users through it. |
| `plan` | `free`, `monthly` or `yearly`: the plan of the current (or last) subscription. |
| `currentProductId`, `currentTransactionId`, `currentPurchaseDate`, `originalTransactionId` | The newest transaction of the subscription. |
| `currentPriceMilli`, `currency` | Its price. `0` during a free trial. |
| `expiresAt` | When the current period ends. |
| `autoRenew`, `autoRenewSource` | Whether it renews. The source is `device` (unsigned StoreKit renewal info, display only) or `apple` (signed App Store notification). |
| `pendingProductId` | A plan change due at the next renewal (a downgrade). |
| `billingRetry`, `revokedAt` | Billing problem / refund. |
| `environment` | `Xcode`, `Sandbox` or `Production`. |

The subscription state is derived, not stored, so it never goes stale:
`none`, then `refunded` if revoked, `expired` once `expiresAt` passes,
`billing_retry`, `cancelled` if `autoRenew` is false, otherwise `active`. The
account has Pro in the `active`, `cancelled` and `billing_retry` states. The
Firebase custom claim `eazeePro` is kept in step with this state, and every
Pro check on the server reads the claim.

## `users/{uid}/transactions/{transactionId}`

One document per App Store transaction (purchase, renewal or plan change),
written when the app verifies it (`/subscriptions/apple/verify`,
`/subscriptions/apple/sync`) or when Apple sends a notification. Writing the
same transaction again changes nothing, so replays are safe.

| Field | Meaning |
|---|---|
| `productId`, `planId` | What was bought. |
| `priceMilli`, `currency`, `storefront` | Price paid. |
| `purchaseDate`, `originalPurchaseDate`, `expiresDate`, `revocationDate` | Dates. |
| `type` | `purchase`, `renewal`, `upgrade`, `downgrade` or `crossgrade`, worked out from the plan it replaced. |
| `status` | The stored part of the status: `active`, `upgraded` or `refunded`. The status shown also derives `expired` (past `expiresDate`) and `cancelled` (`autoRenew` false). |
| `autoRenew` | Copied from the user's document for the current transaction. |
| `isTrial` | An introductory free trial. |
| `environment`, `source` (`app` or `apple_notification`), `uid`, `email`, `originalTransactionId` | Kept on each document for the admin purchase list, which queries all users' transactions at once (collection group). |

## `config/subscription`

Edited in the admin panel (`PUT /admin/config/limits`, `PUT /admin/config/products`).
The server caches it for 60 seconds. If it is missing or invalid, the defaults
in `src/usage/limitsConfig.ts` apply, one section at a time.

```
limits:
  free | pro:
    chatMessagesPerDay   number | null    (null = unlimited)
    voiceMinutesPerDay   number | null
    guidance:
      goalGuidance       /ai/goal-guidance
      taskGuidance       /ai/task-guidance
      recipeSkillGuide   /ai/recipe/generate, /ai/skill/generate (video search needs one left, is not counted)
      guidanceQuestions  /ai/guidance/answer, /ai/recipe/answer, /ai/skill/answer
products:
  "<productId>": { displayOrder, badge, marketingText }   display only; prices come from the App Store
updatedAt, updatedBy
```

Defaults: free gets 5 chat messages, 2 voice minutes and no guidance (0 is
shown as "Pro only"); Pro is unlimited.

## `aiUsage/{uid}/days/{YYYY-MM-DD}`

This collection is unchanged, apart from new counters. One document per user
per local day: `aiActions`, `voiceSeconds`, `unchargedRequests`,
`guidanceGoal`, `guidanceTask`, `guidanceRecipeSkill` and `guidanceQuestions`.
`expireAt` drives the TTL policy in `firestore.indexes.json` (7 days).
Enforcement is still controlled by `SUBSCRIPTION_ENFORCEMENT=true`.

## `revenueDaily/{environment}_{YYYY-MM-DD}`

Totals updated in the same Firestore transaction that first records a
transaction, so the income screen never scans every purchase: `count`,
`grossMilli.{currency}`, `refundCount`, `refundMilli.{currency}` and
`byProduct.{productKey}.{productId,count,grossMilli}`. Days are UTC. Monthly
figures are sums of days. All figures are estimates: real proceeds after
Apple's commission and taxes come from App Store Connect reports.

## `appleNotifications/{notificationUUID}`

A log of App Store Server Notifications that have been handled.

## Deploying rules and indexes

`firebase deploy --only firestore` replaces the rules currently set in the
Firebase console. Check that nothing else depends on those rules first. The
indexes for the admin purchase filters must finish building before
`/admin/purchases` can filter by product or environment.
