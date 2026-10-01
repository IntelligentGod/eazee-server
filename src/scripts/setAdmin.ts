/**
 * Grants or removes the `admin: true` custom claim. This is the only way to
 * make an account an admin; the app never writes roles.
 *
 *   npm run set-admin -- --email someone@eazee.ai
 *   npm run set-admin -- --uid <firebase uid> --remove
 *
 * Uses the same Firebase credentials as the server (FIREBASE_SERVICE_ACCOUNT_JSON
 * or application default credentials). The user gets the new role the next time
 * their ID token refreshes; the app refreshes it when it opens.
 */
import { getFirebaseAuth } from "../auth/firebase";

export function parseSetAdminArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1]?.trim() || null : null;
  };
  const email = value("--email");
  const uid = value("--uid");
  if (!email === !uid) {
    throw new Error("Pass exactly one of --email <address> or --uid <uid>, optionally with --remove");
  }
  return { email, uid, remove: argv.includes("--remove") };
}

/** Keeps every other claim (notably the eazeePro subscription claim). */
export function withAdminClaim(claims: Record<string, unknown> | undefined, isAdmin: boolean) {
  const { admin: _previous, ...others } = claims || {};
  return isAdmin ? { ...others, admin: true } : others;
}

async function main() {
  const args = parseSetAdminArgs(process.argv.slice(2));
  const auth = getFirebaseAuth();
  const user = args.email ? await auth.getUserByEmail(args.email) : await auth.getUser(args.uid!);
  await auth.setCustomUserClaims(user.uid, withAdminClaim(user.customClaims, !args.remove));
  console.log(`${args.remove ? "Removed admin from" : "Granted admin to"} ${user.email || user.uid} (${user.uid})`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
