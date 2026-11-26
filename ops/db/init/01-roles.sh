#!/bin/sh
# Runs once, on an empty data volume, as the container's postgres user.
# Creates the three Operations roles and schema ops by running the frozen
# contract (mounted read-only at /contracts), with the passwords handed over
# as session settings; they are never written to a file or the command line.
set -eu

for v in OPS_OWNER_PASSWORD OPS_APP_PASSWORD OPS_READ_PASSWORD; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "01-roles.sh: $v is not set (see ops/.env.example)" >&2
    exit 1
  fi
done

PGOPTIONS="-c ops.owner_password=$OPS_OWNER_PASSWORD -c ops.app_password=$OPS_APP_PASSWORD -c ops.read_password=$OPS_READ_PASSWORD" \
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /contracts/roles.sql
