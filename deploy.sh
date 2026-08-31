#!/usr/bin/env bash
# GharApp Image Factory — naye GitHub repo pe deploy helper
# Usage: ./deploy.sh <repo-name>   (pehle github.com pe khali repo bana lo)
set -e
REPO="${1:-gharapp-image-factory}"
USER_NAME="$(git config user.name || echo 'jackbhai')"

echo "🔨 Build…"
npm install --no-audit --no-fund
npm run build   # docs/ me prebuilt bundle

echo "📦 Git init…"
[ -d .git ] || git init -b main
git add -A
git commit -m "⚡ GharApp Image Factory — React app + prebuilt docs" || true

echo ""
echo "Ab ye karo:"
echo "  1) https://github.com/new  pe ja ke PUBLIC repo banao:  $REPO   (README/license mat add karna)"
echo "  2) git remote add origin https://github.com/$USER_NAME/$REPO.git"
echo "  3) git push -u origin main"
echo "  4) Repo → Settings → Pages → Source: Deploy from a branch → main / docs → Save"
echo "  5) 1 min me live: https://$USER_NAME.github.io/$REPO/"
