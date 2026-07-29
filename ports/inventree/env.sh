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
export INVENTREE_SITE_URL=http://localhost:8000
export INVENTREE_PLUGINS_ENABLED=True
export INVENTREE_ADMIN_URL=test-admin
export INVENTREE_FRONTEND_API_HOST=http://localhost:8000
export INVENTREE_CORS_ORIGIN_ALLOW_ALL=True
export INVENTREE_COOKIE_SAMESITE=False
export INVENTREE_LOGIN_ATTEMPTS=100
export INVENTREE_PLUGINS_MANDATORY=samplelocate
export INVENTREE_CUSTOM_SPLASH=img/playwright_custom_splash.png
export INVENTREE_CUSTOM_LOGO=img/playwright_custom_logo.png
mkdir -p "$ROOT/data/media" "$ROOT/data/static" "$ROOT/data/backup"
