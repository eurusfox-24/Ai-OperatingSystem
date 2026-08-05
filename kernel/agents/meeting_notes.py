import logging
from typing import List, Optional
from kernel.core.framework import BaseAgent, AgentTask, AgentResult, agent_registry
from kernel.core.llm_provider import llm_provider
from kernel.core.event_bus import event_bus
from kernel.rag.doc_store import doc_engine
from kernel.db.local_manager import db_manager

logger = logging.getLogger("meeting_notes_agent")

DEFAULT_MEETING_NOTES_PROMPT = """You are the Chief Executive Secretary & Knowledge Management Lead sub-agent for Forest Joensuu and Business Joensuu.

YOUR PERSONA & TONE:
- Tone: Methodical, structured, exact, objective, and organized.
- Perspective: You prioritize clarity, tracking executive decisions, assigning action owners, and maintaining pristine database records in Local Embedded SQLite (`sqlite-vec`).

EXECUTION DIRECTIVE:
Process meeting notes/transcripts into executive records containing:
1. Executive Summary & Key Decisions Made
2. Recurring Strategic Themes Identified
3. Next Action Items (Owner, Task, Target Deadline)
4. Proposed Follow-Up Meeting Agenda

STRICT CITATION RULE:
When answering queries based on semantic search results from the RAG database, you MUST ground every single factual claim with an inline citation referencing the exact source document name, using the format [DocumentName.ext]. Example: "The project budget is 5M Euros [financial_report_Q3.pdf]." Do not make any claims that cannot be traced back to a specific source document."""

class MeetingNotesAgent(BaseAgent):
    """Sub-agent for parsing meeting transcripts, performing semantic search on local embedded SQLite (sqlite-vec), and feeding knowledge into RAG."""

    def __init__(self):
        super().__init__(
            name="Meeting Secretary",
            agent_type="MeetingNotesAgent",
            role_label="Meeting Transcripts & Local SQLite Vector Search",
            color="#FFC107", # Yellow
            default_prompt=DEFAULT_MEETING_NOTES_PROMPT,
            provider="azure",
            model="mvp-gpt-54-mini",
            temperature=0.3,
            max_tokens=900
        )

    async def process_task(self, agent_id: str, task: AgentTask) -> AgentResult:
        if task.task_type == "semantic_search":
            query = task.prompt
            await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Performing local SQLite vector search for: {query[:25]}")
            result_sections = []
            for notebook_id in task.context.get("notebook_ids", []):
                result = doc_engine.search_relevant_docs(
                    query,
                    notebook_id=notebook_id,
                    document_names=task.context.get("allowed_source_names", []),
                )
                if result:
                    result_sections.append(f"[PROJECT: {notebook_id}]\n{result}")
            search_results = "\n\n".join(result_sections) or "No internal documents matched the selected projects."
            return AgentResult(
                task_id=task.task_id,
                agent_id=agent_id,
                agent_name=self.name,
                status="success",
                summary=search_results,
                data={"query": query, "search_results": search_results}
            )

        meeting_title = task.context.get("meeting_title", "Executive Board Meeting Notes")
        transcript_text = task.prompt

        await event_bus.notify_agent_update(agent_id, status="working", current_task=f"Parsing transcript for {meeting_title[:20]}")

        prompt = f"""Process the following meeting notes/transcript:
Meeting Title: {meeting_title}

Notes / Transcript:
{transcript_text}

Generate formal executive meeting minutes with decisions and action items."""

        res = llm_provider.chat_completion(
            messages=[
                {"role": "system", "content": self.get_system_prompt(project_id=task.context.get("project_id", ""))},
                {"role": "user", "content": prompt}
            ],
            provider=self.provider,
            model=self.model,
            temperature=self.temperature,
            max_tokens=self.max_tokens
        )

        report = res.get("content", "")

        # Ingest into Local Embedded SQLite Storage & sqlite-vec table
        await event_bus.notify_agent_update(agent_id, status="working", current_task="Storing report in Local Embedded SQLite")
        formatted_filename = f"Meeting_Notes_{meeting_title.replace(' ', '_')}.txt"
        document_content = f"--- MEETING NOTES & DECISIONS RECORD ---\nTitle: {meeting_title}\n\n{report}\n\nRaw Content:\n{transcript_text}"
        
        ingest_result = doc_engine.ingest_document(formatted_filename, document_content.encode('utf-8'))
        project_id = task.context.get("project_id", "")
        if ingest_result.get("status") == "success" and project_id:
            db_manager.add_document_to_notebook(project_id, formatted_filename)
        logger.info(f"MeetingNotesAgent ingested meeting report into local SQLite: {ingest_result}")

        return AgentResult(
            task_id=task.task_id,
            agent_id=agent_id,
            agent_name=self.name,
            status="success",
            summary=report,
            data={
                "meeting_title": meeting_title,
                "report": report,
                "rag_ingest_result": ingest_result,
                "knowledge_base_file": formatted_filename
            }
        )

    async def perform_semantic_search(
        self, query: str, notebook_ids: Optional[List[str]] = None, source_document_names: Optional[List[str]] = None
    ) -> str:
        """Searches only the Manager-provided project source permission scope."""
        task = AgentTask(
            task_type="semantic_search",
            prompt=query,
            context={"notebook_ids": notebook_ids or [], "allowed_source_names": source_document_names or []},
        )
        result = await self.execute(task)
        return result.summary

meeting_notes_agent = MeetingNotesAgent()
agent_registry.register(meeting_notes_agent)
