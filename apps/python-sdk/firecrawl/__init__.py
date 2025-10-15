"""
Firecrawl Python SDK

"""

import logging
import os

from .client import Firecrawl, AsyncFirecrawl, FirecrawlApp, AsyncFirecrawlApp
from .v2.watcher import Watcher
from .v2.watcher_async import AsyncWatcher
from .v1 import (
    V1FirecrawlApp,
    AsyncV1FirecrawlApp,
    V1JsonConfig,
    V1ScrapeOptions,
    V1ChangeTrackingOptions,
)

__version__ = "4.4.0"

# Define the logger for the Firecrawl project
logger: logging.Logger = logging.getLogger("firecrawl")


def _configure_logger() -> None:
    """
    Configure the firecrawl logger for console output.

    The function attaches a handler for console output with a specific format and date
    format to the firecrawl logger.
    """
    try:
        formatter = logging.Formatter(
            "[%(asctime)s - %(name)s:%(lineno)d - %(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)

        logger.addHandler(console_handler)
    except Exception as e:
        logger.error("Failed to configure logging: %s", e)


def setup_logging() -> None:
    """Set up logging based on the FIRECRAWL_LOGGING_LEVEL environment variable."""
    if logger.hasHandlers():
        return

    if not (env := os.getenv("FIRECRAWL_LOGGING_LEVEL", "").upper()):
        logger.addHandler(logging.NullHandler()) 
        return

    _configure_logger()

    if env == "DEBUG":
        logger.setLevel(logging.DEBUG)
    elif env == "INFO":
        logger.setLevel(logging.INFO)
    elif env == "WARNING":
        logger.setLevel(logging.WARNING)
    elif env == "ERROR":
        logger.setLevel(logging.ERROR)
    elif env == "CRITICAL":
        logger.setLevel(logging.CRITICAL)
    else:
        logger.setLevel(logging.INFO)
        logger.warning("Unknown logging level: %s, defaulting to INFO", env)

setup_logging()
logger.debug("Debugging logger setup")

__all__ = [
    'Firecrawl',
    'AsyncFirecrawl',
    'FirecrawlApp',
    'AsyncFirecrawlApp',
    'Watcher',
    'AsyncWatcher',
    'V1FirecrawlApp',
    'AsyncV1FirecrawlApp',
    'V1JsonConfig',
    'V1ScrapeOptions',
    'V1ChangeTrackingOptions',
]
