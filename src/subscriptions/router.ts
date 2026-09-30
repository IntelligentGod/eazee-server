import express, { type Request, type Response } from "express";
import { z } from "zod";
import {
  isFirebaseAuthenticationError,
  verifyFirebaseRequest,
  getFirebaseAuth,
  type AuthenticatedUser,
} from "../auth/firebase";
import {
  AppleTransactionVerificationError,
  verifyAppleSignedTransaction,
  type AppleTransaction,
} from "./appleTransactions";
import {
  PRO_CLAIM_KEY,
  decideEntitlement,
  getAppAccountTokenForUser,
  type ProEntitlementClaim,
} from "./entitlement";

const VerifyBodySchema = z.object({ signedTransaction: z.string().min(1) });

type SubscriptionsRouterOptions = {
  bundleId: string;
  allowXcodeTransactions: boolean;
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
  verifyTransaction?: (signedTransaction: string) => Promise<AppleTransaction>;
  /** Writes or clears the Pro claim, keeping the user's other custom claims. */
  setProClaim?: (uid: string, claim: ProEntitlementClaim | null) => Promise<void>;
};

async function setProClaimInFirebase(uid: string, claim: ProEntitlementClaim | null) {
  const auth = getFirebaseAuth();
  const { customClaims = {} } = await auth.getUser(uid);
  const { [PRO_CLAIM_KEY]: _previous, ...otherClaims } = customClaims;
  await auth.setCustomUserClaims(uid, claim ? { ...otherClaims, [PRO_CLAIM_KEY]: claim } : otherClaims);
}

/**
 * App Store subscription endpoints. The app sends each StoreKit transaction here;
 * only a transaction verified against Apple's signing chain, for this app, and
 * bought by this Eazee account turns Pro on for the account.
 */
export function createSubscriptionsRouter(options: SubscriptionsRouterOptions) {
  const verifyRequest = options.verifyRequest ?? ((req: Request) => verifyFirebaseRequest(req, { checkRevoked: true }));
  const verifyTransaction = options.verifyTransaction
    ?? ((signedTransaction: string) =>
      verifyAppleSignedTransaction(signedTransaction, { allowXcodeEnvironment: options.allowXcodeTransactions }));
  const setProClaim = options.setProClaim ?? setProClaimInFirebase;
  const router = express.Router();

  const authenticate = async (req: Request, res: Response) => {
    try {
      const user = await verifyRequest(req);
      if (!user) res.status(401).json({ error: "Authentication required" });
      return user;
    } catch (error) {
      if (isFirebaseAuthenticationError(error)) {
        res.status(401).json({ error: "Authentication required" });
      } else {
        console.error("[subscriptions] auth failed");
        res.status(500).json({ error: "Authentication unavailable" });
      }
      return null;
    }
  };

  // The app passes this to StoreKit as appAccountToken when purchasing.
  router.get("/apple/account-token", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    res.json({ appAccountToken: getAppAccountTokenForUser(user.uid) });
  });

  router.post("/apple/verify", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;

    const body = VerifyBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "signedTransaction is required" });
    }

    let transaction: AppleTransaction;
    try {
      transaction = await verifyTransaction(body.data.signedTransaction);
    } catch (error) {
      if (error instanceof AppleTransactionVerificationError) {
        return res.status(400).json({ error: "Transaction could not be verified", reason: error.message });
      }
      console.error("[subscriptions] verification failed", error);
      return res.status(500).json({ error: "Verification unavailable" });
    }

    const decision = decideEntitlement(transaction, { uid: user.uid, bundleId: options.bundleId });
    if (decision.status === "rejected") {
      // Never clear the claim here: a mismatched transaction says nothing about this account's own subscription.
      return res.status(403).json({ error: "Transaction does not belong to this account", reason: decision.reason });
    }

    try {
      await setProClaim(user.uid, decision.status === "active" ? decision.claim : null);
    } catch (error) {
      console.error("[subscriptions] could not save entitlement", error);
      return res.status(500).json({ error: "Could not save subscription" });
    }

    return res.json(
      decision.status === "active"
        ? { isPro: true, planId: decision.claim.plan, expiresAt: decision.claim.expiresAt }
        : { isPro: false, planId: null, reason: decision.reason }
    );
  });

  return router;
}
