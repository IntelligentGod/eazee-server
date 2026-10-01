/**
 * One-off, safe to re-run:
 * - creates `users/{uid}` for every Firebase Auth account, so the admin Users
 *   list includes people who have not opened the app since records were added;
 * - migrates the old `admin: true` claim to `role: "admin"`;
 * - mirrors each account's role onto `users/{uid}.role`.
 *
 *   npm run backfill-users
 */
import { getFirebaseAuth } from "../auth/firebase";
import { migrateLegacyClaims, withRoleClaim } from "../auth/roles";
import { createFirestoreSubscriptionRecordsStore } from "../subscriptions/records";

async function main() {
  const auth = getFirebaseAuth();
  const records = createFirestoreSubscriptionRecordsStore();
  let pageToken: string | undefined;
  let count = 0;
  let migrated = 0;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      const role = migrateLegacyClaims(user.customClaims);
      if (user.customClaims?.admin !== undefined) {
        await auth.setCustomUserClaims(user.uid, withRoleClaim(user.customClaims, role));
        migrated += 1;
      }
      const created = Date.parse(user.metadata.creationTime);
      await records.setUserRole(user.uid, role, {
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        providers: user.providerData.map((provider) => provider.providerId),
        authCreatedAt: Number.isFinite(created) ? created : null,
        role,
      }, Date.now());
      count += 1;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  console.log(`Checked ${count} accounts; migrated ${migrated} from admin: true to role: admin`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
