# DEPLOY — meegrow-social (staging)

Target: **social.meegrowlabs.com**, co-hosted on the existing **Postiz box `35.154.66.120`** (already has
Docker + Caddy; Priyanshi operates it). meegrow-social runs its OWN Postgres + Redis containers on a
private Docker network — nothing clashes with Postiz (which uses :5000); only the API is published to
`127.0.0.1:8990` for Caddy to proxy.

## One-time provisioning (human — needs AWS/DNS/SSH access)

1. **DNS**: add an A record `social.meegrowlabs.com → 35.154.66.120` (meegrowlabs.com DNS).
2. **Repo on the box**:
   ```bash
   ssh -i ~/.ssh/antidote-key.pem ubuntu@35.154.66.120
   sudo mkdir -p /opt/meegrow-social && sudo chown $USER /opt/meegrow-social
   git clone git@github.com:prak-gup/meegrow-social.git /opt/meegrow-social   # (deploy key or PAT)
   cd /opt/meegrow-social
   cp .env.production.example .env && nano .env    # fill secrets (see that file)
   ```
3. **Caddy**: append `deploy/Caddyfile.snippet` to `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`.
4. **First boot**:
   ```bash
   docker compose -f compose.prod.yml build
   docker compose -f compose.prod.yml run --rm migrate     # tables + RLS + mgs_app role
   docker compose -f compose.prod.yml up -d api worker
   curl -s https://social.meegrowlabs.com/healthz          # -> {"ok":true}
   ```
5. **CI auto-deploy** (optional): set repo secrets `DEPLOY_HOST=35.154.66.120`, `DEPLOY_USER=ubuntu`,
   `DEPLOY_SSH_KEY=<private key>`. Then every green CI on main auto-deploys (`.github/workflows/deploy.yml`).

## The OAuth callback (why this unblocks approvals)

Once live, the platform apps' **redirect URI** is:

```
https://social.meegrowlabs.com/connect/callback
```

Register that in the Meta / Google / LinkedIn / X app configs (issue #1 / #37). The Google OAuth
homepage + privacy already exist at meegrowlabs.com/social/ + /privacy/.

## Ops

```bash
cd /opt/meegrow-social
docker compose -f compose.prod.yml ps
docker compose -f compose.prod.yml logs -f api worker
docker compose -f compose.prod.yml restart api
```

Backups: a nightly `pg_dump` of the `mgs-prod-postgres` container → S3 is a follow-up (hardening #29).
RLS reminder: the app connects as the non-superuser `mgs_app` role (APP_DATABASE_URL); the admin
DATABASE_URL (mgs) is used only for migrations/provisioning. Both live in `.env` on the box only.

## Decommission Postiz (later, at cutover — #31)

When meegrow-social replaces Postiz for all clients, stop the Postiz compose on this same box and free
its resources; snapshot a final Postiz DB dump first (coordinate with the keep-alive handoff).
