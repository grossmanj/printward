#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-visma-274514}"
REGION="${REGION:-europe-north1}"
SERVICE="${SERVICE:-printward-demo}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-webshop-api@visma-274514.iam.gserviceaccount.com}"
VPC_CONNECTOR="${VPC_CONNECTOR:-connector-cloudrun-sql}"
MIN_INSTANCES="${MIN_INSTANCES:-}"

GCS_BUCKET="${GCS_BUCKET:-pdf-service-bucket}"
GCS_PREFIX="${GCS_PREFIX:-9992/}"
SQLSERVER_HOST="${SQLSERVER_HOST:-10.61.16.34}"
SQLSERVER_DATABASE="${SQLSERVER_DATABASE:-F9992}"
DOC_TYPES="${DOC_TYPES:-packingSlip,attachment}"
FREIGHT_GCS_BUCKET="${FREIGHT_GCS_BUCKET:-}"
FREIGHT_GCS_PREFIX="${FREIGHT_GCS_PREFIX:-}"

if [[ "${INCLUDE_FREIGHT:-false}" == "true" ]]; then
  DOC_TYPES="packingSlip,attachment,freight"
  FREIGHT_GCS_BUCKET="${FREIGHT_GCS_BUCKET:-${GCS_BUCKET}}"
  FREIGHT_GCS_PREFIX="${FREIGHT_GCS_PREFIX:-freight/${GCS_PREFIX}}"
fi

AUTH_FLAGS=("--no-allow-unauthenticated")
if [[ "${ALLOW_UNAUTHENTICATED:-false}" == "true" ]]; then
  AUTH_FLAGS=("--allow-unauthenticated")
fi

SCALING_FLAGS=()
if [[ -n "${MIN_INSTANCES}" ]]; then
  SCALING_FLAGS=("--min-instances" "${MIN_INSTANCES}")
fi

ENV_VARS="^@^GCS_BUCKET=${GCS_BUCKET}@GCS_PREFIX=${GCS_PREFIX}@GCS_MODE=live@ORDER_CONTEXT_MODE=sqlserver@SQLSERVER_HOST=${SQLSERVER_HOST}@SQLSERVER_PORT=1433@SQLSERVER_DATABASE=${SQLSERVER_DATABASE}@STATE_STORE=datastore@DATASTORE_NAMESPACE=printward@REQUIRED_DOCUMENT_TYPES=${DOC_TYPES}@VISIBLE_DOCUMENT_TYPES=${DOC_TYPES}"
if [[ -n "${FREIGHT_GCS_BUCKET}" ]]; then
  ENV_VARS="${ENV_VARS}@FREIGHT_GCS_BUCKET=${FREIGHT_GCS_BUCKET}@FREIGHT_GCS_PREFIX=${FREIGHT_GCS_PREFIX}"
fi

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --source . \
  --service-account "${SERVICE_ACCOUNT}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --vpc-egress private-ranges-only \
  "${SCALING_FLAGS[@]}" \
  "${AUTH_FLAGS[@]}" \
  --set-env-vars "${ENV_VARS}" \
  --set-secrets "SQLSERVER_USER=SQL_UID:latest,SQLSERVER_PASSWORD=SQL_PWD:latest"
