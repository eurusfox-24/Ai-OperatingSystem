import json
import logging
from typing import Set, Dict, Any, Optional
from fastapi import WebSocket

logger = logging.getLogger("event_bus")

class EventBus:
    """Central event bus managing WebSocket connections and broadcasting agent/robot updates."""

    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket, subprotocol: Optional[str] = None):
        await websocket.accept(subprotocol=subprotocol)
        self.active_connections.add(websocket)
        logger.info(f"Client connected. Active clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        logger.info(f"Client disconnected. Active clients: {len(self.active_connections)}")

    async def broadcast(self, message_type: str, data: Dict[str, Any]):
        """Broadcast event to all connected UI clients."""
        payload = json.dumps({
            "type": message_type,
            "data": data
        })
        disconnected = set()
        for connection in self.active_connections:
            try:
                await connection.send_text(payload)
            except Exception as e:
                logger.warning(f"Error sending to websocket client: {e}")
                disconnected.add(connection)
        
        for conn in disconnected:
            self.active_connections.discard(conn)

    async def notify_agent_spawned(self, agent_id: str, name: str, agent_type: str, role_label: str, color: str = "#4CAF50"):
        await self.broadcast("AGENT_SPAWNED", {
            "agent_id": agent_id,
            "name": name,
            "agent_type": agent_type,
            "role_label": role_label,
            "color": color,
            "status": "active"
        })

    async def notify_agent_update(self, agent_id: str, status: str, current_task: str):
        await self.broadcast("AGENT_STATE_UPDATE", {
            "agent_id": agent_id,
            "status": status,
            "current_task": current_task
        })

    async def notify_agent_terminated(self, agent_id: str):
        await self.broadcast("AGENT_TERMINATED", {
            "agent_id": agent_id
        })

    async def notify_workflow_update(
        self,
        workflow_id: str,
        status: str,
        action: str,
        detail: str = "",
    ):
        """Broadcast a high-level, user-safe workflow update.

        These updates intentionally describe observable actions rather than model
        reasoning. The UI uses them to refresh the task's persisted audit trail.
        """
        await self.broadcast("WORKFLOW_UPDATED", {
            "workflow_id": workflow_id,
            "status": status,
            "action": action,
            "detail": detail,
        })

    async def notify_reasoning_summary(
        self,
        session_id: str,
        agent_id: str,
        summary: str,
        status: str = "working",
    ):
        """Broadcast a session-scoped, user-safe account of observable work.

        This is deliberately authored from application checkpoints. It must not
        contain provider chain-of-thought, hidden prompts, credentials, or raw
        tool payloads.
        """
        await self.broadcast("REASONING_SUMMARY", {
            "session_id": session_id,
            "agent_id": agent_id,
            "summary": summary,
            "status": status,
        })

event_bus = EventBus()
