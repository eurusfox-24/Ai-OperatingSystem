import logging
from typing import Dict, Any
from kernel.agents.meeting_notes import meeting_notes_agent
from kernel.core.framework import AgentTask

logger = logging.getLogger("secretary_agent")

class SecretaryAgent:
    """Legacy wrapper for MeetingNotesAgent."""

    async def process_transcript(self, meeting_title: str, transcript_text: str) -> Dict[str, Any]:
        task = AgentTask(
            task_type="process_transcript",
            prompt=transcript_text,
            context={"meeting_title": meeting_title}
        )
        res = await meeting_notes_agent.execute(task)
        return {
            "agent_id": res.agent_id,
            "meeting_title": meeting_title,
            "report": res.summary,
            "rag_ingest_result": res.data.get("rag_ingest_result")
        }

secretary_agent = SecretaryAgent()
