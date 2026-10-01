import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { migrateLegacyClaims, readRoleClaim, withRoleClaim, type Role } from "../auth/roles";
import { bootstrapSuperAdmin, changeUserRole, RoleChangeError, type AuthAccount, type RoleAuth } from "../admin/roleService";
import { createAdminRouter } from "../admin/router";
import { createMemorySubscriptionRecordsStore } from "../subscriptions/records";
import { createMemoryConfigStore, createSubscriptionConfigProvider } from "../usage/limitsConfig";
import { createMemoryUsageStore } from "../usage/usageStore";

const SUPER_EMAIL = "supereazee@eazee.ai";
const PRO_CLAIM = { plan: "yearly", expiresAt: 1, originalTransactionId: "t" };

/** An in-memory stand-in for Firebase Auth that records passwords only to prove they are never reset. */
function createFakeAuth(seed: Array<Partial<AuthAccount> & { uid: string; password?: string }> = []) {
  const accounts = new Map<string, AuthAccount & { password?: string }>();
  for (const account of seed) {
    accounts.set(account.uid, {
      email: null, displayName: null, providers: ["password"], createdAt: 0, customClaims: {}, ...account,
    });
  }
  const revoked: string[] = [];
  let nextId = 1;
  let failClaims = false;
  const auth: RoleAuth = {
    async getUser(uid) {
      return accounts.get(uid) ?? null;
    },
    async getUserByEmail(email) {
      return [...accounts.values()].find((account) => account.email === email) ?? null;
    },
    async createUser({ email, password }) {
      const account = { uid: `created-${nextId++}`, email, displayName: null, providers: ["password"], createdAt: 0, customClaims: {}, password };
      accounts.set(account.uid, account);
      return account;
    },
    async setCustomUserClaims(uid, claims) {
      if (failClaims) throw new Error("auth down");
      const account = accounts.get(uid)!;
      accounts.set(uid, { ...account, customClaims: claims });
    },
    async revokeRefreshTokens(uid) {
      revoked.push(uid);
    },
  };
  return { auth, accounts, revoked, failClaimsNext: () => { failClaims = true; } };
}

test("roles come only from the role claim, and an unknown value is a customer", () => {
  assert.equal(readRoleClaim("superAdmin"), "superAdmin");
  assert.equal(readRoleClaim("admin"), "admin");
  assert.equal(readRoleClaim("owner"), "customer");
  assert.equal(readRoleClaim(undefined), "customer");
  assert.equal(migrateLegacyClaims({ admin: true }), "admin", "the old admin: true claim migrates to admin");
  assert.deepEqual(withRoleClaim({ eazeePro: PRO_CLAIM, admin: true }, "admin"), { eazeePro: PRO_CLAIM, role: "admin" });
  assert.deepEqual(withRoleClaim({ eazeePro: PRO_CLAIM, role: "admin" }, "customer"), { eazeePro: PRO_CLAIM });
});

test("the super admin bootstrap is idempotent and never resets a password", async () => {
  const fake = createFakeAuth();
  const records = createMemorySubscriptionRecordsStore();

  const first = await bootstrapSuperAdmin({ email: " SuperEazee@eazee.ai ", password: "first-password", auth: fake.auth, records });
  assert.equal(first.status, "created");
  const uid = (first as { uid: string }).uid;
  assert.equal(fake.accounts.get(uid)?.email, SUPER_EMAIL, "stored in lowercase");
  assert.equal(fake.accounts.get(uid)?.customClaims.role, "superAdmin");
  assert.equal((await records.getUser(uid))?.role, "superAdmin");
  assert.deepEqual(records.superAdmin, { uid, email: SUPER_EMAIL });

  const second = await bootstrapSuperAdmin({ email: SUPER_EMAIL, password: "a-new-password", auth: fake.auth, records });
  assert.equal(second.status, "unchanged");
  assert.equal(fake.accounts.get(uid)?.password, "first-password", "an existing password is never changed");
  assert.equal(fake.accounts.size, 1);

  assert.deepEqual(await bootstrapSuperAdmin({ email: undefined, password: "x", auth: fake.auth, records }), { status: "skipped" });
});

test("the bootstrap promotes an existing account and keeps its other claims", async () => {
  const fake = createFakeAuth([{ uid: "existing", email: SUPER_EMAIL, customClaims: { eazeePro: PRO_CLAIM } }]);
  const records = createMemorySubscriptionRecordsStore();
  const result = await bootstrapSuperAdmin({ email: SUPER_EMAIL, password: undefined, auth: fake.auth, records });
  assert.equal(result.status, "promoted");
  assert.deepEqual(fake.accounts.get("existing")?.customClaims, { eazeePro: PRO_CLAIM, role: "superAdmin" });
  await assert.rejects(
    bootstrapSuperAdmin({ email: "missing@eazee.ai", password: undefined, auth: fake.auth, records }),
    /SUPER_ADMIN_PASSWORD/
  );
});

test("a role change updates the claim and Firestore together, revokes tokens and is audited", async () => {
  const fake = createFakeAuth([
    { uid: "super", email: SUPER_EMAIL, customClaims: { role: "superAdmin" } },
    { uid: "carol", email: "carol@example.com", customClaims: { eazeePro: PRO_CLAIM } },
  ]);
  const records = createMemorySubscriptionRecordsStore();
  const actor = { uid: "super", email: SUPER_EMAIL };

  const promoted = await changeUserRole({ actor, targetUid: "carol", role: "admin", auth: fake.auth, records, now: 10 });
  assert.deepEqual([promoted.changed, promoted.from, promoted.to], [true, "customer", "admin"]);
  assert.deepEqual(fake.accounts.get("carol")?.customClaims, { eazeePro: PRO_CLAIM, role: "admin" });
  assert.equal((await records.getUser("carol"))?.role, "admin");
  assert.equal((await records.getUser("carol"))?.email, "carol@example.com", "a missing users doc is created whole");
  assert.deepEqual(fake.revoked, ["carol"]);

  await changeUserRole({ actor, targetUid: "carol", role: "customer", auth: fake.auth, records, now: 20 });
  assert.deepEqual(fake.accounts.get("carol")?.customClaims, { eazeePro: PRO_CLAIM });
  assert.equal((await records.getUser("carol"))?.role, "customer");

  const log = await records.listRoleChanges({ limit: 10 });
  assert.deepEqual(log.map((change) => [change.from, change.to, change.changedBy, change.at]), [
    ["admin", "customer", "super", 20],
    ["customer", "admin", "super", 10],
  ]);

  const unchanged = await changeUserRole({ actor, targetUid: "carol", role: "customer", auth: fake.auth, records });
  assert.equal(unchanged.changed, false);
  assert.equal((await records.listRoleChanges({ limit: 10 })).length, 2, "a no-op is not audited");
});

test("nobody can change their own role, and the super admin can never be demoted", async () => {
  const fake = createFakeAuth([
    { uid: "super", email: SUPER_EMAIL, customClaims: { role: "superAdmin" } },
    { uid: "other-super", email: "x@eazee.ai", customClaims: { role: "superAdmin" } },
  ]);
  const records = createMemorySubscriptionRecordsStore();
  const attempt = (targetUid: string, role: "customer" | "admin") =>
    changeUserRole({ actor: { uid: "super" }, targetUid, role, auth: fake.auth, records });

  await assert.rejects(attempt("super", "customer"), (error: RoleChangeError) => error.code === "CANNOT_CHANGE_OWN_ROLE");
  await assert.rejects(attempt("other-super", "admin"), (error: RoleChangeError) => error.code === "CANNOT_CHANGE_SUPER_ADMIN");
  await assert.rejects(attempt("ghost", "admin"), (error: RoleChangeError) => error.status === 404);
  assert.equal(fake.accounts.get("super")?.customClaims.role, "superAdmin");
});

test("if Firestore cannot be updated the claim is put back, so the two never disagree", async () => {
  const fake = createFakeAuth([{ uid: "dave", email: "dave@example.com", customClaims: {} }]);
  const records = createMemorySubscriptionRecordsStore();
  records.setUserRole = async () => { throw new Error("Firestore down"); };

  await assert.rejects(changeUserRole({ actor: { uid: "super" }, targetUid: "dave", role: "admin", auth: fake.auth, records }), /Firestore down/);
  assert.deepEqual(fake.accounts.get("dave")?.customClaims, {});
  assert.deepEqual(fake.revoked, []);
});

async function startAdminApp() {
  const fake = createFakeAuth([
    { uid: "super", email: SUPER_EMAIL, customClaims: { role: "superAdmin" } },
    { uid: "admin-1", email: "admin@eazee.ai", customClaims: { role: "admin" } },
    { uid: "erin", email: "erin@example.com", customClaims: {} },
  ]);
  const records = createMemorySubscriptionRecordsStore();
  for (const [uid, role] of [["super", "superAdmin"], ["admin-1", "admin"], ["erin", "customer"]] as Array<[string, Role]>) {
    const account = fake.accounts.get(uid)!;
    await records.setUserRole(uid, role, { email: account.email, displayName: null, providers: [], authCreatedAt: 0 }, 0);
  }
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter({
    records,
    config: createSubscriptionConfigProvider({ store: createMemoryConfigStore() }),
    usage: createMemoryUsageStore(),
    unlimitedEmails: [],
    roleAuth: fake.auth,
    getAuthUser: async (uid) => ({ uid }),
    verifyRequest: async (req) => {
      const uid = req.header("x-test-uid");
      if (!uid) return null;
      return { uid, email: fake.accounts.get(uid)?.email ?? undefined, authTime: 0, role: readRoleClaim(fake.accounts.get(uid)?.customClaims.role) };
    },
  }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, uid: string, body?: unknown) => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-test-uid": uid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { server, request, fake };
}

test("the role endpoint is for super admins only; admins get 403", async () => {
  const { server, request, fake } = await startAdminApp();
  try {
    const byAdmin = await request("/admin/users/erin/role", "admin-1", { role: "admin" });
    assert.equal(byAdmin.status, 403);
    assert.equal((await byAdmin.json()).code, "SUPER_ADMIN_REQUIRED");
    assert.equal((await request("/admin/users/erin/role", "erin", { role: "admin" })).status, 403, "customers are refused too");
    assert.equal((await request("/admin/role-changes", "admin-1")).status, 403);

    assert.equal((await request("/admin/users/erin/role", "super", { role: "superAdmin" })).status, 400, "superAdmin cannot be assigned");
    assert.equal((await request("/admin/users/super/role", "super", { role: "customer" })).status, 400);

    const promoted = await request("/admin/users/erin/role", "super", { role: "admin" });
    assert.equal(promoted.status, 200);
    assert.equal(fake.accounts.get("erin")?.customClaims.role, "admin");

    const log = await (await request("/admin/role-changes", "super")).json();
    assert.equal(log.changes[0].targetUid, "erin");
    assert.equal(log.changes[0].changedByEmail, SUPER_EMAIL);
  } finally {
    server.close();
  }
});

test("admins and super admins can use the admin panel, filtered by role", async () => {
  const { server, request } = await startAdminApp();
  try {
    assert.equal((await request("/admin/users", "admin-1")).status, 200);
    assert.equal((await request("/admin/users", "erin")).status, 403);
    const me = await (await request("/admin/me", "super")).json();
    assert.equal(me.role, "superAdmin");

    const admins = await (await request("/admin/users?role=admin", "super")).json();
    assert.deepEqual(admins.users.map((user: any) => [user.uid, user.role]), [["admin-1", "admin"]]);
    assert.equal((await request("/admin/users?role=owner", "super")).status, 400);

    const everyone = await (await request("/admin/users", "super")).json();
    assert.deepEqual(everyone.users.map((user: any) => user.uid).sort(), ["admin-1", "erin"], "the super admin is never listed");
    assert.equal((await request("/admin/users?role=superAdmin", "super")).status, 400, "nor offered as a filter");
  } finally {
    server.close();
  }
});
