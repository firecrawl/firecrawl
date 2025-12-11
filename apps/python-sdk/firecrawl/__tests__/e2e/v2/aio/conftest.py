"""
Pytest configuration for async E2E tests.
Ensures environment variables are loaded before any test runs.
"""
import os
import pytest
from dotenv import load_dotenv, find_dotenv

# Load environment IMMEDIATELY at module import time (before pytest collects tests)
# This ensures env vars are loaded before the first test runs
_env_loaded = False

def _ensure_env_loaded():
    """Ensure environment is loaded exactly once, synchronously."""
    global _env_loaded
    if not _env_loaded:
        # Find and load .env from multiple possible locations
        env_file = find_dotenv(usecwd=True)
        if env_file:
            load_dotenv(env_file, override=True)
        else:
            # Try loading from current directory
            load_dotenv(override=True)
        _env_loaded = True

# Load env immediately when this module is imported
_ensure_env_loaded()


@pytest.fixture(scope="session", autouse=True)
def load_environment():
    """Ensure environment variables are loaded before running any tests."""
    # Double-check env is loaded (should already be done at import time)
    _ensure_env_loaded()
    
    # Validate required environment variables
    required_vars = ["API_KEY", "API_URL"]
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    
    if missing_vars:
        pytest.skip(f"Skipping E2E tests: Missing required environment variables: {', '.join(missing_vars)}")
    
    yield


@pytest.fixture(scope="function")
def api_key():
    """Provide API key for tests."""
    key = os.getenv("API_KEY")
    if not key:
        pytest.skip("API_KEY not set")
    return key


@pytest.fixture(scope="function")
def api_url():
    """Provide API URL for tests."""
    url = os.getenv("API_URL")
    if not url:
        pytest.skip("API_URL not set")
    return url

