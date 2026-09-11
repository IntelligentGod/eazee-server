# Account Deletion Deployment

Set these production environment variables before releasing the in-app Delete Account action:

```text
APPLE_TEAM_ID
APPLE_KEY_ID
APPLE_PRIVATE_KEY
APPLE_CLIENT_ID=com.eazee.ai
ACCOUNT_DELETION_SIGNING_SECRET
```

Create the key under Apple Developer → Certificates, Identifiers & Profiles → Keys, enable Sign in with Apple,
and associate it with the primary App ID `com.eazee.ai`. An App Store Connect API key will not work.
Keep the private key only in the backend environment.
For this app, `APPLE_TEAM_ID=4CQHQ9H75G` and `APPLE_CLIENT_ID=com.eazee.ai`. `APPLE_KEY_ID`
must match the Sign in with Apple key, and `APPLE_PRIVATE_KEY` must contain that key's complete `.p8`
contents. Restart or redeploy the backend after changing these values.
Set `ACCOUNT_DELETION_SIGNING_SECRET` to a random value of at least 32 characters. It signs status-only recovery tokens used to safely confirm deletion after interrupted requests. Keep this secret stable across deployments so interrupted deletions remain recoverable.

App Review navigation:

```text
Home -> Settings -> Manage Account -> Delete Account
```

Deletion immediately removes Firebase Auth and local Eazee data. It revokes Eazee's Google and Apple access without deleting user-owned Gmail messages or Google Calendar events.
