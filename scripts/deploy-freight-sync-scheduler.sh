#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-visma-274514}"
REGION="${REGION:-europe-north1}"
JOB="${JOB:-printward-freight-sync-demo}"
SCHEDULER_JOB="${SCHEDULER_JOB:-printward-freight-sync-demo-every-5m}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-webshop-api@visma-274514.iam.gserviceaccount.com}"
SCHEDULE="${SCHEDULE:-*/5 * * * *}"
TIME_ZONE="${TIME_ZONE:-Europe/Stockholm}"

URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run"

gcloud scheduler jobs create http "${SCHEDULER_JOB}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --schedule "${SCHEDULE}" \
  --time-zone "${TIME_ZONE}" \
  --uri "${URI}" \
  --http-method POST \
  --oauth-service-account-email "${SERVICE_ACCOUNT}"
