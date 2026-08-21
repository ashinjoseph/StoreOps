#!/usr/bin/env bash
# Restore RetailPOS_DB from a SQL Server .bak into a local Docker container.
# Usage: ./restore.sh /path/to/RetailPOS_DB.bak
set -euo pipefail

BAK="${1:?usage: ./restore.sh /path/to/RetailPOS_DB.bak}"
[ -f "$BAK" ] || { echo "no such file: $BAK" >&2; exit 1; }

SA_PASS="${SA_PASS:-Str0ng!Passw0rd#2026}"
IMAGE=mcr.microsoft.com/mssql/server:2022-latest
STAGE="$(mktemp -d)"
cp "$BAK" "$STAGE/retailpos.bak"

docker rm -f sqlsrv >/dev/null 2>&1 || true
docker run -d --name sqlsrv \
  -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=$SA_PASS" -e MSSQL_PID=Developer \
  -p 1433:1433 -v "$STAGE:/backups" "$IMAGE" >/dev/null

echo -n "waiting for sql server"
for _ in $(seq 1 60); do
  if docker exec sqlsrv /opt/mssql-tools18/bin/sqlcmd \
       -S localhost -U sa -P "$SA_PASS" -C -Q "SELECT 1" >/dev/null 2>&1; then
    echo " ready"; break
  fi
  echo -n .; sleep 2
done

docker exec sqlsrv mkdir -p /var/opt/mssql/restored
docker exec sqlsrv /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$SA_PASS" -C -Q "
RESTORE DATABASE RetailPOS_DB FROM DISK='/backups/retailpos.bak'
WITH MOVE 'RetailPOS_DB'     TO '/var/opt/mssql/restored/RetailPOS_DB.mdf',
     MOVE 'RetailPOS_DB_log' TO '/var/opt/mssql/restored/RetailPOS_DB_log.ldf',
     REPLACE, STATS=25;"

echo "restored. now run ./extract.sh"
