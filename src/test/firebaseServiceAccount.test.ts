import test from "node:test";
import assert from "node:assert/strict";
import { parseServiceAccount } from "../auth/firebase";

const account = { type: "service_account", project_id: "demo-project", client_email: "svc@demo-project.iam.gserviceaccount.com" };

test("the service account can be raw JSON or base64-encoded JSON", () => {
  assert.deepEqual(parseServiceAccount(JSON.stringify(account)), account);
  assert.deepEqual(parseServiceAccount(`  ${JSON.stringify(account, null, 2)}\n`), account);
  assert.deepEqual(parseServiceAccount(Buffer.from(JSON.stringify(account, null, 2)).toString("base64")), account);
});

test("a bad value fails with a message that does not repeat it", () => {
  assert.throws(() => parseServiceAccount("not-a-secret-value"), (error: Error) => {
    assert.match(error.message, /service account JSON or that JSON base64-encoded/);
    assert.doesNotMatch(error.message, /not-a-secret-value/);
    return true;
  });
});
