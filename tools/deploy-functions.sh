#!/bin/sh
# Déploie des fonctions Edge Supabase avec leurs options (ADR 0016).
# Usage : tools/deploy-functions.sh [fonction…]       (toutes si aucune n'est donnée)
#         tools/deploy-functions.sh --changed BASE    (celles touchées depuis le commit BASE)
# Variables : SUPABASE_PROJECT_REF (projet, défaut : production) ; SUPABASE_ACCESS_TOKEN en CI.
# Les migrations ne sont jamais appliquées ici : elles restent manuelles (SQL Editor), dans l'ordre.
set -eu
cd "$(dirname "$0")/.."
REF="${SUPABASE_PROJECT_REF:-tuhbzziqyisdnqzfvtkh}"
ALL="depot import-stock listes offers order search wechat-events"
# Fonctions appelées sans jeton Supabase (page publique, WeChat) : elles vérifient elles-mêmes leurs appels.
PUBLIC="depot listes offers order search wechat-events"
# Fonctions qui importent supabase/functions/_shared/.
SHARED="depot listes order wechat-events"

if [ "${1:-}" = "--changed" ]; then
  BASE="$2"
  FILES=$(git diff --name-only "$BASE" HEAD -- supabase/functions)
  LIST=""
  for f in $ALL; do
    if echo "$FILES" | grep -q "^supabase/functions/$f/"; then LIST="$LIST $f"; fi
  done
  if echo "$FILES" | grep -q "^supabase/functions/_shared/"; then LIST="$LIST $SHARED"; fi
  LIST=$(echo $LIST | tr ' ' '\n' | sort -u | tr '\n' ' ')
else
  LIST="${*:-$ALL}"
fi

if [ -z "$(echo $LIST)" ]; then echo "Aucune fonction à déployer."; exit 0; fi
for f in $LIST; do
  case " $ALL " in *" $f "*) ;; *) echo "Fonction inconnue : $f" >&2; exit 1 ;; esac
  FLAGS="--project-ref $REF --use-api"
  case " $PUBLIC " in *" $f "*) FLAGS="$FLAGS --no-verify-jwt" ;; esac
  echo "Déploiement de $f"
  supabase functions deploy "$f" $FLAGS
done
