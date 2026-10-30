#!/bin/sh
# Teste le schéma Supabase sur un PostgreSQL local jetable : migrations, données fictives, RLS, intégrité, imports de stock.
# Usage : tools/test-db.sh [hôte] [port]   (par défaut : socket /var/tmp, port 54329, utilisateur postgres)
# Crée puis supprime la base cp_test. Ne touche jamais au projet Supabase.
set -eu
cd "$(dirname "$0")/../supabase"
H="${1:-/var/tmp}"; PORT="${2:-54329}"
P="psql -h $H -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$P -c 'drop database if exists cp_test' -c 'create database cp_test'
$P -d cp_test -f checks/00_stub_supabase.sql
for f in migrations/*.sql; do $P -d cp_test -f "$f"; done
$P -d cp_test -f seed.sql
TOTAL=0
for f in checks/0[1-9]*.sql; do
  OUT=$($P -d cp_test -f "$f" 2>&1) || { echo "$f :"; echo "$OUT" | grep -v 'NOTICE:  ok'; exit 1; }
  TOTAL=$((TOTAL + $(echo "$OUT" | grep -c 'NOTICE:  ok')))
done
echo "$TOTAL contrôles passés."
$P -c 'drop database cp_test'
