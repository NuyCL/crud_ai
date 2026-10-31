"""Entry point: `uvicorn app.main:app --port 8080`, or `python -m app.main` which reads PORT.

The application is built when this module is imported, so a missing ADMIN_KEY or CLIENT_KEY stops the
process at start-up instead of at the first request.
"""

from __future__ import annotations

import uvicorn

from app.config import load_config
from app.handler import create_app
from app.repository import SqliteRepository
from app.service import Service

config = load_config()
app = create_app(Service(SqliteRepository(config.db_path)), config.admin_key, config.client_key, config.cors_origins)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=config.port)
