"""Typed, project-scoped external data connectors."""

from .service import connector_service
from .agentmail import agentmail_service

__all__ = ["connector_service", "agentmail_service"]
