# RUNBOOK.md — Sellable v3 Operations

## Local Development

```bash
# 1. Clone and install
git clone <repo>
cd sellable
npm install

# 2. Copy and configure env
cp .env.example .env
# Edit .env with your Razorpay test keys

# 3. Start infrastructure
docker compose up -d db redis

# 4. Run migrations and seed
npm run seed

# 5. Start dev server
npm run dev

# 6. Access
# Dashboard: http://localhost:3000/ops/dashboard
# Login: admin@sellable.io / admin123
# Health: http://localhost:3000/healthz
```

## Docker Compose (Full Stack)

```bash
docker compose up -d
# App runs on :3000, Postgres on :5432, Redis on :6379
```

## Staging/Production Deployment

### Single Service Mode
```bash
PROCESS_ROLE=all npm start
```

### Split Mode (API + Worker replicas)
```bash
# API instance
PROCESS_ROLE=api npm start

# Worker instance
PROCESS_ROLE=worker npm start
```

### Environment Variables
- Set `RAZORPAY_MODE=live`, `LIVE_MODE_ACK=true`, `ENABLE_DEV_TOOLS=false`
- Ensure `ABANDON_MINUTES >= 60` for live mode
- Use HTTPS with `BASE_URL=https://your-domain.com`
- Configure webhook URL in Razorpay dashboard: `https://your-domain.com/webhooks/razorpay`

## Ops Procedures

### Approve/Deny Escalations
1. Login to dashboard
2. Go to Approvals panel
3. Review context and rationale
4. Click Approve or Deny
5. Decision is recorded in audit ledger

### Resume Circuit Breaker
- Circuit breaker auto-resets after 60 seconds
- If stuck, restart the worker process

### Investigate Reconciliation Mismatch
1. Check `/ops/status` for last reconciliation result
2. Review audit log for unmatched payments
3. Use "Reconcile" button on dashboard to trigger manual run
4. Check dead_letters table for failed webhook events

### Rotate Buyer Keys
1. Go to Buyer API Keys panel in dashboard
2. Revoke old key
3. Create new key
4. Distribute new key to agents

### Inspect Dead Letters
```sql
SELECT * FROM dead_letters ORDER BY created_at DESC LIMIT 10;
SELECT * FROM webhook_events WHERE status = 'failed';
```

### Verify Ledger Chain
```bash
curl -X POST http://localhost:3000/ops/verify-chain \
  -H "Cookie: session=<jwt>"
```

### Export Ledger Checkpoints
```bash
curl -X POST http://localhost:3000/ops/checkpoint \
  -H "Cookie: session=<jwt>"
```

## Live-Mode Flip Checklist

1. [ ] Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to live values
2. [ ] Set `RAZORPAY_MODE=live`
3. [ ] Set `LIVE_MODE_ACK=true`
4. [ ] Set `ENABLE_DEV_TOOLS=false`
5. [ ] Set `ABANDON_MINUTES >= 60`
6. [ ] Set `BASE_URL` to HTTPS domain
7. [ ] Configure webhook URL in Razorpay dashboard
8. [ ] Review policy thresholds in dashboard
9. [ ] Test with small amounts first
10. [ ] Monitor dashboard for first 24 hours

## Rollback

- Use previous Docker image tag
- Database migrations are forward-only; if rollback requires schema change, create a new forward migration
- Always backup database before major changes

## Monitoring

- Health: `GET /healthz`
- Readiness: `GET /readyz` (checks DB + Redis)
- Dashboard: `GET /ops/dashboard` (requires auth)
- Queue status: `GET /ops/status`
- Structured logs via pino (JSON in production)
