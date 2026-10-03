"""Shared test setup: tests keep their log lines out of logs/server.log (J05)."""
import logging

# setup_logging() only adds its file handler to a logger with no handlers, so claim the logger first
_log = logging.getLogger("cg")
_log.setLevel(logging.INFO)
_log.addHandler(logging.NullHandler())
