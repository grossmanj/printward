#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-visma-274514}"
RUN_REGION="${RUN_REGION:-${REGION:-europe-north1}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-europe-west1}"
JOB="${JOB:-printward-freight-sync-demo}"
SCHEDULER_JOB="${SCHEDULER_JOB:-printward-freight-sync-demo-every-5m}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-webshop-api@visma-274514.iam.gserviceaccount.com}"
SCHEDULE="${SCHEDULE:-*/5 * * * *}"
TIME_ZONE="${TIME_ZONE:-Europe/Stockholm}"

URI="https://${RUN_REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run"

if gcloud scheduler jobs describe "${SCHEDULER_JOB}" --project "${PROJECT_ID}" --location "${SCHEDULER_LOCATION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SCHEDULER_JOB}" \
    --project "${PROJECT_ID}" \
    --location "${SCHEDULER_LOCATION}" \
    --schedule "${SCHEDULE}" \
    --time-zone "${TIME_ZONE}" \
    --uri "${URI}" \
    --http-method POST \
    --oauth-service-account-email "${SERVICE_ACCOUNT}"
else
  gcloud scheduler jobs create http "${SCHEDULER_JOB}" \
    --project "${PROJECT_ID}" \
    --location "${SCHEDULER_LOCATION}" \
    --schedule "${SCHEDULE}" \
    --time-zone "${TIME_ZONE}" \
    --uri "${URI}" \
    --http-method POST \
    --oauth-service-account-email "${SERVICE_ACCOUNT}"
fi
