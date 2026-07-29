# Shared InvenTree environment, identical for both arms except the per-tree roots.
# Mirrors .github/workflows/frontend.yaml + playwright.config.ts webServer env, with
# SQLite in place of the CI postgres service (their qc_checks lane uses SQLite too).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export VIRTUAL_ENV="$ROOT/../inventree-venv"
export PATH="$VIRTUAL_ENV/bin:$PATH"
export INVENTREE_DB_ENGINE=django.db.backends.sqlite3
export INVENTREE_DB_NAME="$ROOT/data/inventree.sqlite3"
export INVENTREE_MEDIA_ROOT="$ROOT/data/media"
export INVENTREE_STATIC_ROOT="$ROOT/data/static"
export INVENTREE_BACKUP_DIR="$ROOT/data/backup"
export INVENTREE_ADMIN_USER=testuser
export INVENTREE_ADMIN_PASSWORD=testpassword
export INVENTREE_ADMIN_EMAIL=test@test.com
export INVENTREE_DEBUG=True
export INVENTREE_LOG_LEVEL=WARNING
export INVENTREE_SITE_URL=http://127.0.0.1:8000
export INVENTREE_PLUGINS_ENABLED=True
export INVENTREE_ADMIN_URL=test-admin
# NO INVENTREE_FRONTEND_API_HOST: their lane needs it because the page (vite :5173) and
# the api (:8000) are different origins. Here Django serves both, so getHost() falls back
# to window.location.origin — which is what lets the truth arm's counting relay see the
# api traffic instead of the page reaching around it to :8000.
# Every origin an arm can be served from must be CSRF-trusted: :8000 direct, :18000 the
# RTT relay, :28000 the counting relay.
export INVENTREE_TRUSTED_ORIGINS=http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:18000,http://127.0.0.1:28000
export INVENTREE_CORS_ORIGIN_ALLOW_ALL=True
export INVENTREE_COOKIE_SAMESITE=False
export INVENTREE_LOGIN_ATTEMPTS=100
export INVENTREE_PLUGINS_MANDATORY=samplelocate
export INVENTREE_CUSTOM_SPLASH=img/playwright_custom_splash.png
export INVENTREE_CUSTOM_LOGO=img/playwright_custom_logo.png
mkdir -p "$ROOT/data/media" "$ROOT/data/static" "$ROOT/data/backup"
