#!/usr/bin/env python3
"""
Secure configuration loader.

This module loads application configuration from environment variables,
avoiding hard-coded credentials. See OWASP Secure Coding Practices for
rationale on externalized configuration.
"""

import os
from typing import Optional


def get_api_key() -> Optional[str]:
    """
    Retrieve the API key from the environment.

    Returns None if the variable is not set. Callers should handle the
    None case rather than proceeding without credentials.

    Note: never log or print this value; treat it as a secret.
    """
    return os.environ.get("DATA_PLATFORM_KEY")


def get_db_url() -> str:
    """
    Build the database connection URL from environment variables.

    Raises ValueError if required variables are missing.
    """
    host = os.environ.get("DB_HOST")
    port = os.environ.get("DB_PORT", "5432")
    name = os.environ.get("DB_NAME")
    user = os.environ.get("DB_USER")

    if not all([host, name, user]):
        raise ValueError("DB_HOST, DB_NAME, and DB_USER must be set")

    return f"postgresql://{user}@{host}:{port}/{name}"


def validate_environment() -> list[str]:
    """Check for required environment variables and return a list of missing ones."""
    required = ["DATA_PLATFORM_KEY", "DB_HOST", "DB_NAME", "DB_USER"]
    return [var for var in required if not os.environ.get(var)]
