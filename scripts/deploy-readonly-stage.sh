#!/usr/bin/env bash
set -euo pipefail

# Isolated, IAM-only dashboard verification against the Visma demo company.
# Deliberately fixed targets: never reuse the live demo/prod service or state namespace.
gcloud run deploy printward-dashboard-stage \
  --project visma-274514 \
  --region europe-north1 \
  --source . \
  --service-account webshop-api@visma-274514.iam.gserviceaccount.com \
  --vpc-connector connector-cloudrun-sql \
  --vpc-egress private-ranges-only \
  --no-allow-unauthenticated \
  --min-instances 0 \
  --max-instances 1 \
  --set-env-vars '^@^GCS_BUCKET=pdf-service-bucket@GCS_PREFIX=9992/@GCS_MODE=live@FREIGHT_GCS_BUCKET=pdf-service-bucket@FREIGHT_GCS_PREFIX=freight/9992/@ORDER_CONTEXT_MODE=sqlserver@SQLSERVER_HOST=10.61.16.34@SQLSERVER_PORT=1433@SQLSERVER_DATABASE=F9992@STATE_STORE=datastore@DATASTORE_NAMESPACE=printward_dashboard_stage@REQUIRED_DOCUMENT_TYPES=packingSlip,attachment@VISIBLE_DOCUMENT_TYPES=pallet,packingSlip,attachment,freight@PRINTWARD_READ_ONLY=true@PRINTWARD_AUTH_ENABLED=false@NSHIFT_FETCH_ENABLED=false@ORDERS_CACHE_WARMUP=false' \
  --set-secrets SQLSERVER_USER=SQL_UID:latest,SQLSERVER_PASSWORD=SQL_PWD:latest
