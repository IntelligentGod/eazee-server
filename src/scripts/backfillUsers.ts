/**
 * One-off: creates `users/{uid}` for every existing Firebase Auth account, so
 * the admin Users list includes people who have not opened the app since the
 * subscription records were added. Safe to re-run; existing documents are kept.
 *
 *   npm run backfill-users
 */
import { getFirebaseAuth } from "../auth/firebase";
import { createFirestoreSubscriptionRecordsStore } from "../subscriptions/records";

async function main() {
  const auth = getFirebaseAuth();
  const records = createFirestoreSubscriptionRecordsStore();
  let pageToken: string | undefined;
  let count = 0;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      const created = Date.parse(user.metadata.creationTime);
      await records.ensureUser(user.uid, async () => ({
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        providers: user.providerData.map((provider) => provider.providerId),
        authCreatedAt: Number.isFinite(created) ? created : null,
      }));
      count += 1;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  console.log(`Checked ${count} accounts`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
