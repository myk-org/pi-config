"""Named Python loggers for pi tools."""

import logging


def create_logger(name: str) -> logging.Logger:
    """Return the standard-library logger for a pi tools component."""
    return logging.getLogger(name)
