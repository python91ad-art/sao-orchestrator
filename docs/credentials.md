# SAO Credential Management

SAO supports runtime management of third-party API credentials from the Dashboard Settings page.

## Architecture

Administrators update credentials through authenticated admin-only tRPC procedures under `settings.credentials.*`. The backend encrypts each credential with AES-256-GCM and stores only ciphertext plus metadata in MySQL.

The `integration_credentials` table stores:

- service
- encrypted value
- encryption version
- enabled status
- created timestamp
- updated timestamp

The `credential_audit_logs` table records safe audit metadata for credential changes and tests. It never stores plaintext credentials, ciphertext, authorization headers, or encryption key material.

## Master Encryption Key

Set `SAO_CREDENTIAL_ENCRYPTION_KEY` in the runtime environment. It must decode to exactly 32 bytes. Use a base64 or 64-character hex value.

Generate a base64 key with:

```sh
openssl rand -base64 32
```

Generate a hex key with:

```sh
openssl rand -hex 32
```

The key must remain in Northflank or environment secrets. Do not commit it. If this key is lost, credentials already encrypted in MySQL cannot be recovered.

In production, SAO fails startup if the key is missing or malformed. In development, the app can start without the key, but database-backed credential set/decrypt operations will fail until it is configured.

## Fallback Precedence

Runtime integrations resolve credentials in this order:

1. Enabled database-managed credential
2. Existing environment variable fallback

This keeps current Northflank deployments working while allowing key rotation from the dashboard without redeploying.

Fallback variables:

- `groq` -> `GROQ_API_KEY`
- `google-search` -> `GOOGLE_SEARCH_API_KEY`
- `google-search-cx` -> `GOOGLE_SEARCH_CX`
- `github` -> `GITHUB_TOKEN`
- `stripe` -> `STRIPE_SECRET_KEY`
- `resend` -> `RESEND_API_KEY`
- `slack` -> `SLACK_BOT_TOKEN`
- `tavily` -> `TAVILY_API_KEY`

`SLACK_CHANNEL` and `STRIPE_WEBHOOK_SECRET` remain environment configuration values.

## Dashboard Operations

The Settings page shows only safe metadata:

- service name
- configured status
- enabled/disabled status
- last updated timestamp

It never displays stored credential values. Password fields are only temporary entry fields for add/replace actions and are cleared after save.

Supported administrator actions:

- add or replace credential
- test effective runtime credential
- enable or disable database credential
- remove database credential

Removing or disabling a database credential may expose the environment fallback if that variable is configured.
