import { X509Certificate } from "node:crypto";
import { compactVerify, decodeJwt, decodeProtectedHeader } from "jose";

/**
 * SHA-256 fingerprint of Apple Root CA - G3, which anchors every App Store
 * signed transaction. Published at https://www.apple.com/certificateauthority/
 */
export const APPLE_ROOT_CA_G3_SHA256 =
  "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179";

// A developer's own Apple-issued certificate (e.g. code signing) also chains to
// Apple's root, so the chain alone is not enough: the leaf and intermediate must
// carry the App Store receipt-signing OIDs.
// DER encodings of OIDs 1.2.840.113635.100.6.11.1 (leaf) and 1.2.840.113635.100.6.2.1 (intermediate).
const RECEIPT_SIGNING_LEAF_OID = Buffer.from("060a2a864886f76364060b01", "hex");
const WWDR_INTERMEDIATE_OID = Buffer.from("060a2a864886f76364060201", "hex");

/** Fields of Apple's JWSTransactionDecodedPayload that entitlement checks rely on. */
export type AppleTransaction = {
  bundleId: string;
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  type?: string;
  environment?: string;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
  /** "PURCHASE" or "RENEWAL"; a plan switch is a PURCHASE with a new transactionId. */
  transactionReason?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  /** Apple reports prices in milliunits of `currency` (9990 = 9.99). */
  priceMilli?: number;
  currency?: string;
  storefront?: string;
  /** 1 introductory (e.g. free trial), 2 promotional, 3 offer code, 4 win-back. */
  offerType?: number;
  offerDiscountType?: string;
  /** Set on a transaction superseded by an immediate upgrade. */
  isUpgraded?: boolean;
};

/** Fields of Apple's JWSRenewalInfoDecodedPayload; only ever read from a verified notification. */
export type AppleRenewalInfo = {
  originalTransactionId?: string;
  productId?: string;
  autoRenewProductId?: string;
  autoRenewStatus?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  expirationIntent?: number;
};

export class AppleTransactionVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleTransactionVerificationError";
  }
}

const fail = (message: string): never => {
  throw new AppleTransactionVerificationError(message);
};

function assertCertificateValidNow(certificate: X509Certificate, now: Date) {
  if (new Date(certificate.validFrom) > now || new Date(certificate.validTo) < now) {
    fail("Certificate in the transaction chain is not currently valid");
  }
}

export function toTransaction(payload: Record<string, unknown>): AppleTransaction {
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const time = (value: unknown) => (typeof value === "number" ? value : undefined);
  const bundleId = text(payload.bundleId);
  const productId = text(payload.productId);
  const transactionId = text(payload.transactionId);
  const originalTransactionId = text(payload.originalTransactionId);
  if (!bundleId || !productId || !transactionId || !originalTransactionId) {
    fail("Transaction payload is missing required fields");
  }
  return {
    bundleId: bundleId!,
    productId: productId!,
    transactionId: transactionId!,
    originalTransactionId: originalTransactionId!,
    type: text(payload.type),
    environment: text(payload.environment),
    expiresDate: time(payload.expiresDate),
    revocationDate: time(payload.revocationDate),
    appAccountToken: text(payload.appAccountToken)?.toLowerCase(),
    transactionReason: text(payload.transactionReason),
    purchaseDate: time(payload.purchaseDate),
    originalPurchaseDate: time(payload.originalPurchaseDate),
    priceMilli: time(payload.price),
    currency: text(payload.currency),
    storefront: text(payload.storefront),
    offerType: time(payload.offerType),
    offerDiscountType: text(payload.offerDiscountType),
    isUpgraded: payload.isUpgraded === true ? true : undefined,
  };
}

export function toRenewalInfo(payload: Record<string, unknown>): AppleRenewalInfo {
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const time = (value: unknown) => (typeof value === "number" ? value : undefined);
  return {
    originalTransactionId: text(payload.originalTransactionId),
    productId: text(payload.productId),
    autoRenewProductId: text(payload.autoRenewProductId),
    autoRenewStatus: time(payload.autoRenewStatus),
    isInBillingRetryPeriod: typeof payload.isInBillingRetryPeriod === "boolean" ? payload.isInBillingRetryPeriod : undefined,
    gracePeriodExpiresDate: time(payload.gracePeriodExpiresDate),
    expirationIntent: time(payload.expirationIntent),
  };
}

/**
 * Verifies any App Store signed payload (transaction, renewal info, or server
 * notification) against Apple Root CA - G3 and returns its decoded payload.
 */
export async function verifyAppleJws(
  jws: string,
  options: { rootFingerprintSha256?: string; now?: Date } = {}
): Promise<Record<string, unknown>> {
  const now = options.now ?? new Date();
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    return fail("Transaction is not a valid JWS");
  }

  const chain = Array.isArray(header.x5c) ? header.x5c : [];
  if (header.alg !== "ES256" || chain.length < 3) {
    fail("Transaction is not signed with an App Store certificate chain");
  }

  const [leaf, intermediate, root] = chain.slice(0, 3).map((der) => new X509Certificate(Buffer.from(der, "base64")));
  const expectedRoot = (options.rootFingerprintSha256 ?? APPLE_ROOT_CA_G3_SHA256).toUpperCase();
  if (root.fingerprint256.replace(/:/g, "").toUpperCase() !== expectedRoot) {
    fail("Transaction chain does not end at Apple Root CA - G3");
  }
  if (!root.verify(root.publicKey) || !intermediate.verify(root.publicKey) || !leaf.verify(intermediate.publicKey)) {
    fail("Transaction certificate chain signature is invalid");
  }
  if (!leaf.raw.includes(RECEIPT_SIGNING_LEAF_OID) || !intermediate.raw.includes(WWDR_INTERMEDIATE_OID)) {
    fail("Transaction is not signed by an App Store receipt-signing certificate");
  }
  [leaf, intermediate, root].forEach((certificate) => assertCertificateValidNow(certificate, now));

  try {
    const { payload } = await compactVerify(jws, leaf.publicKey);
    return JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch (error) {
    if (error instanceof AppleTransactionVerificationError) throw error;
    return fail("Transaction signature is invalid");
  }
}

/**
 * Verifies a StoreKit 2 signed transaction (JWS) and returns its payload.
 *
 * Transactions from Xcode's local StoreKit testing are signed by a local
 * certificate, not Apple's chain; they are only accepted when
 * `allowXcodeEnvironment` is set, which getConfig refuses outside APP_ENV=development.
 */
export async function verifyAppleSignedTransaction(
  signedTransaction: string,
  options: { allowXcodeEnvironment?: boolean; rootFingerprintSha256?: string; now?: Date } = {}
): Promise<AppleTransaction> {
  if (options.allowXcodeEnvironment) {
    let unverifiedPayload: Record<string, unknown>;
    try {
      decodeProtectedHeader(signedTransaction);
      unverifiedPayload = decodeJwt(signedTransaction) as Record<string, unknown>;
    } catch {
      return fail("Transaction is not a valid JWS");
    }
    if (unverifiedPayload.environment === "Xcode") {
      return toTransaction(unverifiedPayload);
    }
  }
  return toTransaction(await verifyAppleJws(signedTransaction, options));
}
