#!/bin/sh
# Teste le schéma Supabase sur un PostgreSQL local jetable : migration, données fictives, RLS, intégrité.
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
OUT=$($P -d cp_test -f checks/01_rls.sql 2>&1) || { echo "$OUT" | grep -v 'NOTICE:  ok'; exit 1; }
echo "$(echo "$OUT" | grep -c 'NOTICE:  ok') contrôles passés."
$P -c 'drop database cp_test'
