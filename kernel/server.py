import logging
import asyncio
import datetime
import json
import re
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Callable, Dict, Any, List, Literal, Optional

from kernel.core.event_bus import event_bus
from kernel.core.god_mode import god_mode_engine
from kernel.core.users import user_manager
from kernel.core.framework import agent_registry, AgentTask
from kernel.db.local_manager import db_manager
from kernel.core.llm_provider import llm_provider
from kernel.agents.manager import manager_agent
from kernel.agents.autonomous_research import autonomous_research_agent
from kernel.rag.doc_store import doc_engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("kernel_server")

app = FastAPI(title="Forest Joensuu AI OS Kernel")
autonomous_background_tasks = set()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class LoginRequest(BaseModel):
    username: str
    password: str

class CustomizationRequest(BaseModel):
    username: str
    tone_style: str
    custom_instructions: str

class PromptRequest(BaseModel):
    prompt: str
    username: Optional[str] = "mikko"
    session_id: Optional[str] = None
    image_data: Optional[str] = None
    # One Manager model decides whether tools are needed. Explicit deep
    # research remains a separate workflow.
    research_mode: Literal["auto", "rag", "rag_internet"] = "auto"
    notebook_ids: List[str] = []
    project_id: Optional[str] = None
    source_document_names: List[str] = []

class ChatSessionCreateRequest(BaseModel):
    username: Optional[str] = "mikko"
    project_id: Optional[str] = None
    title: Optional[str] = "New chat"

class ChatSessionMessageRequest(BaseModel):
    username: Optional[str] = "mikko"
    project_id: Optional[str] = None
    role: Literal["user", "assistant"]
    content_md: str
    metadata: Dict[str, Any] = {}

class NotebookCreateRequest(BaseModel):
    name: str
    company_id: Optional[str] = ""
    description: str = ""
    project_brief_md: str = ""
    knowledge_boundary_md: str = ""

class NotebookProjectUpdateRequest(BaseModel):
    name: Optional[str] = None
    company_id: Optional[str] = None
    description: Optional[str] = None
    project_brief_md: Optional[str] = None
    knowledge_boundary_md: Optional[str] = None
    project_status: Optional[str] = None

class OrganizationContextRequest(BaseModel):
    name: str = "Forest Joensuu"
    mission_md: str = ""
    priorities_md: str = ""
    constraints_md: str = ""
    decision_principles_md: str = ""

class PartnerCompanyRequest(BaseModel):
    name: str
    context_md: str = ""
    priorities_md: str = ""
    constraints_md: str = ""

class AutonomousResearchRequest(BaseModel):
    query: str
    username: Optional[str] = "mikko"
    notebook_ids: List[str] = []
    project_id: Optional[str] = None
    source_document_names: List[str] = []
    max_web_sources: int = 3
    research_mode: Literal["rag", "rag_internet"] = "rag_internet"

class AutonomousApprovalDecision(BaseModel):
    status: Literal["approved", "rejected"]
    decided_by: Optional[str] = "mikko"

class AutonomousSteeringRequest(BaseModel):
    direction: str


def resolve_selected_project_scope(
    notebook_ids: List[str], requested_source_names: Optional[List[str]] = None
) -> tuple[List[str], List[str], str, Dict[str, str], str]:
    """Validates selected projects and preserves the requested file boundary."""
    valid_ids: List[str] = []
    source_names: List[str] = []
    project_names: Dict[str, str] = {}
    seen_sources = set()
    requested_sources = (
        {str(name).strip() for name in requested_source_names if str(name).strip()}
        if requested_source_names is not None
        else None
    )
    for raw_id in notebook_ids:
        notebook_id = str(raw_id or "").strip()
        if not notebook_id or notebook_id in valid_ids:
            continue
        notebook = db_manager.get_notebook(notebook_id)
        if not notebook:
            continue
        valid_ids.append(notebook_id)
        project_names[notebook_id] = str(notebook.get("name") or notebook_id)
        for doc_name in notebook.get("doc_names", []):
            if requested_sources is not None and doc_name not in requested_sources:
                continue
            if doc_name not in seen_sources:
                source_names.append(doc_name)
                seen_sources.add(doc_name)
    scope_id = "projects:" + "|".join(sorted(valid_ids)) if valid_ids else ""
    return valid_ids, source_names, scope_id, project_names, db_manager.compile_business_context(valid_ids)

class AgentPromptUpdateRequest(BaseModel):
    agent_type: str
    system_prompt: str
    provider: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None

class SearchRequest(BaseModel):
    query: str
    top_k: Optional[int] = 3

class SkillRequest(BaseModel):
    name: str
    description: str
    markdown_body: str

class APIKeysUpdateRequest(BaseModel):
    azure_endpoint: Optional[str] = None
    azure_api_key: Optional[str] = None
    azure_api_version: Optional[str] = None
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    ollama_endpoint: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    groq_api_key: Optional[str] = None

@app.get("/api/health")
def health_check():
    return {
        "status": "online",
        "os": "Linux VM AI Habitat",
        "model": manager_agent.model,
        "provider": manager_agent.provider
    }

class AddModelRequest(BaseModel):
    provider_id: str
    model_name: str

class TestProviderRequest(BaseModel):
    provider_id: str

class ProviderRegistryDraftRequest(BaseModel):
    provider_id: Optional[str] = None
    name: str
    adapter: str = "custom_adapter"
    endpoint: Optional[str] = ""
    models: List[str] = []
    note: Optional[str] = ""

@app.get("/api/providers/list")
def list_providers_endpoint():
    """Returns available LLM provider catalog and active status."""
    return {"providers": llm_provider.get_available_providers()}

@app.get("/api/providers/registry")
def get_provider_registry_endpoint():
    """Returns the developer setup registry, including non-routable provider drafts."""
    return {"providers": llm_provider.get_provider_registry()}

@app.post("/api/providers/registry")
def create_provider_registry_draft_endpoint(req: ProviderRegistryDraftRequest):
    """Adds a provider setup draft. Drafts do not enable runtime routing."""
    try:
        return llm_provider.save_provider_registry_draft(req.provider_id or req.name, req.dict())
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))

@app.put("/api/providers/registry/{provider_id}")
def update_provider_registry_draft_endpoint(provider_id: str, req: ProviderRegistryDraftRequest):
    """Updates a provider setup draft without changing live agent routing."""
    try:
        return llm_provider.save_provider_registry_draft(provider_id, req.dict())
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))

@app.get("/api/providers/keys")
def get_provider_keys_endpoint():
    """Returns masked API keys status for front-end management."""
    return llm_provider.get_api_keys_status()

@app.post("/api/providers/keys/update")
def update_provider_keys_endpoint(req: APIKeysUpdateRequest):
    """Updates API keys dynamically in kernel memory and persists them to data/api_keys.json."""
    update_payload = {k: v for k, v in req.dict().items() if v is not None and v.strip() != ""}
    res = llm_provider.update_api_keys(update_payload)
    return {
        "status": "success",
        "message": "API keys updated successfully and persisted to Kernel storage.",
        "keys_status": res
    }

@app.post("/api/providers/model/add")
def add_custom_model_endpoint(req: AddModelRequest):
    """Adds a custom model deployment to a provider catalog."""
    try:
        res = llm_provider.add_custom_model(req.provider_id, req.model_name)
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/providers/test")
def test_provider_endpoint(req: TestProviderRequest):
    """Performs a live API connection test for a selected provider."""
    return llm_provider.test_provider_connection(req.provider_id)

@app.get("/api/providers/usage")
def get_api_usage_endpoint():
    """Returns aggregated API usage statistics across all LLM providers."""
    return llm_provider.get_api_usage_status()


@app.get("/api/agents")
def list_agents_endpoint():
    """Returns list of all registered sub-agents in the Agentic Orchestration Framework."""
    return {"agents": agent_registry.list_agents()}

@app.get("/api/agents/prompts")
def get_agent_prompts_endpoint():
    """Returns system prompts and model configs for Manager Agent and all sub-agents from local embedded SQLite."""
    db_profiles = db_manager.get_all_agent_profiles()

    manager_saved = db_profiles.get("ManagerAgent", {})
    manager_prompt = manager_saved.get("soul_md") or manager_agent.get_system_prompt()
    manager_provider = manager_saved.get("provider") or manager_agent.provider
    manager_model = manager_saved.get("model") or manager_agent.model

    prompts = {
        "ManagerAgent": {
            "name": "Manager Agent (Executive Assistant)",
            "agent_type": "ManagerAgent",
            "role": "Primary UI Chat Hub & Helpful AI Assistant (ChatGPT/Gemini style)",
            "color": "#10b981",
            "system_prompt": manager_prompt,
            "provider": manager_provider,
            "model": manager_model,
            "temperature": manager_agent.temperature,
            "max_tokens": manager_agent.max_tokens
        }
    }
    for agent_info in agent_registry.list_agents():
        agent_obj = agent_registry.get_agent(agent_info["agent_type"])
        if agent_obj:
            saved_entry = db_profiles.get(agent_obj.agent_type, {})
            prompt_str = saved_entry.get("soul_md") or agent_obj.get_system_prompt()
            provider_str = saved_entry.get("provider") or agent_obj.provider
            model_str = saved_entry.get("model") or agent_obj.model

            prompts[agent_obj.agent_type] = {
                "name": agent_obj.name,
                "agent_type": agent_obj.agent_type,
                "role": agent_obj.role_label,
                "color": agent_obj.color,
                "system_prompt": prompt_str,
                "provider": provider_str,
                "model": model_str,
                "temperature": agent_obj.temperature,
                "max_tokens": agent_obj.max_tokens
            }
    return {
        "prompts": prompts,
        "available_providers": llm_provider.get_available_providers()
    }

@app.post("/api/agents/prompt/update")
def update_agent_prompt_endpoint(req: AgentPromptUpdateRequest):
    """Saves updated system prompt & model provider settings into local embedded SQLite and applies to active Kernel memory."""
    agent_name = "Sub-Agent"
    if req.agent_type.lower() == "manageragent":
        agent_name = "Manager Agent"
        manager_agent.update_system_prompt(req.system_prompt)
        manager_agent.update_model_config(
            provider=req.provider,
            model=req.model,
            temperature=req.temperature,
            max_tokens=req.max_tokens
        )
    else:
        agent_obj = agent_registry.get_agent(req.agent_type)
        if agent_obj:
            agent_name = agent_obj.name
            agent_obj.update_system_prompt(req.system_prompt)
            agent_obj.update_model_config(
                provider=req.provider,
                model=req.model,
                temperature=req.temperature,
                max_tokens=req.max_tokens
            )
        else:
            raise HTTPException(status_code=404, detail="Agent not found.")

    return {
        "status": "success",
        "agent_type": req.agent_type,
        "provider": manager_agent.provider if req.agent_type.lower() == "manageragent" else agent_obj.provider,
        "model": manager_agent.model if req.agent_type.lower() == "manageragent" else agent_obj.model,
        "supabase_status": "Saved & Persisted in Local Embedded SQLite (agent_profiles table)",
        "message": f"System prompt & model config for {agent_name} successfully saved to local SQLite & applied to Kernel memory."
    }

@app.post("/api/auth/login")
def login_endpoint(req: LoginRequest):
    profile = user_manager.authenticate(req.username, req.password)
    if not profile:
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    return {"status": "success", "user": profile}

@app.post("/api/user/customization")
def update_customization_endpoint(req: CustomizationRequest):
    try:
        updated_profile = user_manager.update_customization(req.username, req.tone_style, req.custom_instructions)
        return {"status": "success", "user": updated_profile}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/chat/sessions")
def list_chat_sessions_endpoint(username: str = Query("mikko"), project_id: str = Query("")):
    """Lists all conversations for the signed-in user.

    Project and file selection is request context for the Manager; it does not
    select a different conversation namespace.
    """
    return {"sessions": db_manager.list_chat_sessions(username or "mikko", "")}

@app.post("/api/chat/sessions")
def create_chat_session_endpoint(req: ChatSessionCreateRequest):
    session = db_manager.create_chat_session(
        req.username or "mikko", (req.project_id or "").strip(), req.title or "New chat"
    )
    if not session:
        raise HTTPException(status_code=500, detail="Unable to create a chat session")
    return {"status": "success", "session": session}

@app.get("/api/chat/sessions/{session_id}")
def get_chat_session_endpoint(session_id: str, username: str = Query("mikko"), project_id: str = Query("")):
    session = db_manager.get_chat_session(session_id, username or "mikko", "")
    messages = db_manager.get_chat_session_messages(session_id, username or "mikko", "")
    if not session or messages is None:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return {"session": session, "messages": messages}

@app.post("/api/chat/sessions/{session_id}/messages")
def append_chat_session_message_endpoint(session_id: str, req: ChatSessionMessageRequest):
    message_id = db_manager.append_chat_message(
        session_id,
        req.username or "mikko",
        "",
        req.role,
        req.content_md,
        req.metadata,
    )
    if message_id is None:
        raise HTTPException(status_code=404, detail="Unable to save message to this chat session")
    return {"status": "success", "message_id": message_id}

@app.delete("/api/chat/sessions/{session_id}")
def delete_chat_session_endpoint(session_id: str, username: str = Query("mikko"), project_id: str = Query("")):
    if not db_manager.delete_chat_session(session_id, username or "mikko", ""):
        raise HTTPException(status_code=404, detail="Chat session not found")
    return {"status": "success"}

@app.post("/api/chat/sessions/{session_id}/steer")
async def steer_manager_chat_endpoint(session_id: str, req: AutonomousSteeringRequest):
    """Adds user direction to an in-flight Manager task at its next checkpoint."""
    direction = req.direction.strip()
    if not direction:
        raise HTTPException(status_code=400, detail="A direction is required")
    if len(direction) > 2_000:
        raise HTTPException(status_code=400, detail="Direction is too long")
    if not manager_agent.steer_session(session_id, direction):
        raise HTTPException(status_code=409, detail="This Manager task has already reached its next checkpoint")
    return {"status": "accepted", "message": "Direction queued for the Manager's next safe checkpoint."}

async def _execute_chat_request(
    req: PromptRequest, stream_callback: Optional[Callable[[str], None]] = None
):
    user_name = req.username or "mikko"
    try:
        notebook_ids, scoped_sources, project_id, project_names, business_context = resolve_selected_project_scope(
            req.notebook_ids, req.source_document_names
        )
        session_id = (req.session_id or "").strip()
        if session_id:
            if not db_manager.get_chat_session(session_id, user_name, ""):
                raise HTTPException(status_code=404, detail="Chat session not found")
        else:
            session = db_manager.create_chat_session(user_name, project_id)
            session_id = session.get("id", "")
            if not session_id:
                raise HTTPException(status_code=500, detail="Unable to create a chat session")

        scheduled_time = _extract_delayed_task_time(req.prompt)
        if scheduled_time:
            task_id = str(uuid.uuid4())
            task_prompt = _DELAYED_TASK_RE.sub("", req.prompt, count=1).strip(" ,.;")
            if not db_manager.add_kanban_task(
                task_id,
                task_prompt or req.prompt.strip(),
                scheduled_time,
                "UTC",
                username=user_name,
                notebook_ids=notebook_ids,
                schedule_enabled=True,
                chat_session_id=session_id,
            ):
                raise HTTPException(status_code=500, detail="Could not schedule the agent task")
            response_md = (
                "✅ **Agent task scheduled.**\n\n"
                f"The Manager will run this task at **{scheduled_time}**. "
                "It is now visible in **Kanban → Pending**, where you can edit it or run it immediately."
            )
            db_manager.append_chat_message(
                session_id,
                user_name,
                project_id,
                "user",
                req.prompt,
                {"kind": "scheduled_kanban_request", "task_id": task_id, "scheduled_time": scheduled_time},
            )
            db_manager.append_chat_message(
                session_id,
                user_name,
                project_id,
                "assistant",
                response_md,
                {"kind": "scheduled_kanban_confirmation", "task_id": task_id, "scheduled_time": scheduled_time},
            )
            await event_bus.broadcast(
                "KANBAN_TASK_UPDATED",
                {"task_id": task_id, "status": "pending", "scheduled_time": scheduled_time},
            )
            return {
                "response": response_md,
                "session_id": session_id,
                "task_id": task_id,
                "scheduled_time": scheduled_time,
                "sub_agents_used": [],
                "user_context": user_name,
                "mode": "SCHEDULED_AGENT_TASK",
                "provider": "scheduler",
                "model": "manager-task-router",
                "reasoning_summary": ["Recognized a delayed request and created a scheduled Manager task."],
            }

        manager_task = AgentTask(
            task_type="managed_chat",
            prompt=req.prompt,
            username=user_name,
            context={
                "session_id": session_id,
                "image_data": req.image_data,
                "research_mode": req.research_mode,
                "notebook_ids": notebook_ids,
                "allowed_source_names": scoped_sources,
                "project_id": project_id,
                "project_names": project_names,
                "business_context": business_context,
                "stream_callback": stream_callback,
            },
        )
        manager_result = await manager_agent.execute(manager_task)
        if manager_result.status == "error":
            raise RuntimeError(manager_result.summary)
        return manager_result.data
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error handling user prompt '{req.prompt}': {e}", exc_info=True)
        return {
            "response": f"⚠️ **AI OS Kernel Exception:** An error occurred while processing your request: `{str(e)}`",
            "sub_agents_used": [],
            "user_context": user_name,
            "mode": "ERROR",
            "provider": manager_agent.provider,
            "model": manager_agent.model
        }


@app.post("/api/chat")
async def chat_endpoint(req: PromptRequest):
    return await _execute_chat_request(req)


@app.post("/api/chat/stream")
async def chat_stream_endpoint(req: PromptRequest):
    """Streams Manager text deltas as NDJSON, then emits the complete result."""
    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def on_delta(delta: str) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "delta", "text": delta})

        async def run_manager() -> None:
            try:
                result = await _execute_chat_request(req, stream_callback=on_delta)
                await queue.put({"type": "done", "data": result})
            except Exception as exc:
                logger.error("Streaming Manager request failed: %s", exc, exc_info=True)
                await queue.put({"type": "error", "message": str(exc)})

        producer = asyncio.create_task(run_manager())
        try:
            while True:
                event = await queue.get()
                yield json.dumps(event, ensure_ascii=False) + "\n"
                if event["type"] in {"done", "error"}:
                    break
        finally:
            if not producer.done():
                producer.cancel()

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@app.get("/api/autonomy/capabilities")
def autonomous_capabilities_endpoint():
    """Documents the runner's explicit autonomy policy for the UI and developers."""
    return {
        "agent": autonomous_research_agent.name,
        "capabilities": autonomous_research_agent.capability_manifest(),
        "policy": "Read-only research runs autonomously; consequential actions must be named and approved.",
    }


@app.post("/api/autonomy/research")
async def create_autonomous_research_endpoint(req: AutonomousResearchRequest):
    """Queues a bounded NotebookLM + public-web research mission."""
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="A research question is required")
    if len(query) > autonomous_research_agent.MAX_QUERY_CHARS:
        raise HTTPException(status_code=400, detail="Research question is too long")

    task_id = f"research_{uuid.uuid4().hex}"
    max_web_sources = max(1, min(req.max_web_sources, 3))
    notebook_ids, scoped_sources, project_id, _project_names, business_context = resolve_selected_project_scope(
        req.notebook_ids, req.source_document_names
    )
    if not db_manager.create_autonomous_task(
        task_id,
        query,
        req.username or "mikko",
        notebook_ids,
        scoped_sources,
        max_web_sources,
        context={"business_context": business_context},
    ):
        raise HTTPException(status_code=500, detail="Could not create the research task")

    background_task = asyncio.create_task(autonomous_research_agent.run_task(task_id))
    autonomous_background_tasks.add(background_task)
    background_task.add_done_callback(autonomous_background_tasks.discard)
    return {
        "status": "queued",
        "task_id": task_id,
        "message": "Deep research is gathering notebook and public-web evidence.",
    }


@app.get("/api/autonomy/tasks/{task_id}")
def get_autonomous_task_endpoint(task_id: str):
    task = db_manager.get_autonomous_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Research task not found")
    return task


@app.get("/api/autonomy/tasks")
def list_autonomous_tasks_endpoint(username: Optional[str] = None, limit: int = Query(100, ge=1, le=200)):
    """Lists persisted agent work so people can review completed and in-progress activity."""
    return {"tasks": db_manager.list_autonomous_tasks(username=username, limit=limit)}


@app.post("/api/autonomy/tasks/{task_id}/cancel")
async def cancel_autonomous_task_endpoint(task_id: str):
    """Cooperatively stop a task at its next safe workflow boundary."""
    if not db_manager.request_autonomous_task_cancel(task_id):
        raise HTTPException(status_code=409, detail="Only queued or running research tasks can be stopped")
    await event_bus.notify_workflow_update(
        task_id,
        "running",
        "Stop requested — completing the current safe boundary.",
    )
    return {"status": "stop_requested", "message": "The task will stop before its next workflow step."}


@app.post("/api/autonomy/tasks/{task_id}/steer")
async def steer_autonomous_task_endpoint(task_id: str, req: AutonomousSteeringRequest):
    """Queue a user direction for the next safe research step."""
    direction = req.direction.strip()
    if not direction:
        raise HTTPException(status_code=400, detail="A direction is required")
    if len(direction) > 2_000:
        raise HTTPException(status_code=400, detail="Direction is too long")
    if not db_manager.add_autonomous_task_steering(task_id, direction):
        raise HTTPException(status_code=409, detail="Only queued or running research tasks can be steered")
    await event_bus.notify_workflow_update(
        task_id,
        "running",
        "New direction received — it will apply at the next safe step.",
    )
    return {"status": "accepted", "message": "Direction queued for the next safe workflow step."}


@app.post("/api/autonomy/approvals/{approval_id}")
def decide_autonomous_approval_endpoint(approval_id: int, req: AutonomousApprovalDecision):
    """Records a human decision; approval alone never grants arbitrary shell access."""
    if not db_manager.decide_autonomous_approval(approval_id, req.status, req.decided_by or "mikko"):
        raise HTTPException(status_code=404, detail="Pending approval not found")
    return {"status": "success"}


@app.post("/api/documents/upload")
async def upload_document_endpoint(file: UploadFile = File(...), notebook_id: Optional[str] = Form(None)):
    safe_name = (file.filename or "").replace("\\", "/").split("/")[-1]
    if not safe_name or safe_name in {".", ".."}:
        raise HTTPException(status_code=400, detail="A valid document filename is required")
    content = await file.read()
    res = doc_engine.ingest_document(safe_name, content)
    if res.get("status") == "success" and notebook_id:
        if not db_manager.add_document_to_notebook(notebook_id, safe_name):
            raise HTTPException(status_code=400, detail="Document was ingested but could not be assigned to the selected notebook")
    return res

@app.get("/api/documents/list")
def list_documents_endpoint():
    """Returns metadata and AI summaries for all uploaded/ingested documents from local embedded SQLite."""
    return {"documents": doc_engine.list_ingested_documents()}

@app.get("/api/notebooks")
def list_notebooks_endpoint():
    """Lists real NotebookLM-style source collections and their documents."""
    return {"notebooks": db_manager.ensure_default_notebook()}

@app.get("/api/business-context")
def get_business_context_endpoint():
    """Returns the shared Forest Joensuu DNA and reusable partner-company context."""
    return {
        "organization": db_manager.get_organization_context(),
        "companies": db_manager.list_partner_companies(),
    }

@app.put("/api/business-context/organization")
def save_organization_context_endpoint(req: OrganizationContextRequest):
    organization = db_manager.save_organization_context(
        req.name,
        req.mission_md,
        req.priorities_md,
        req.constraints_md,
        req.decision_principles_md,
    )
    if not organization:
        raise HTTPException(status_code=500, detail="Could not save Forest Joensuu DNA")
    return {"status": "success", "organization": organization}

@app.post("/api/business-context/companies")
def create_partner_company_endpoint(req: PartnerCompanyRequest):
    company = db_manager.save_partner_company(
        req.name, req.context_md, req.priorities_md, req.constraints_md
    )
    if not company:
        raise HTTPException(status_code=400, detail="A partner company name is required")
    return {"status": "success", "company": company}

@app.put("/api/business-context/companies/{company_id}")
def update_partner_company_endpoint(company_id: str, req: PartnerCompanyRequest):
    company = db_manager.save_partner_company(
        req.name, req.context_md, req.priorities_md, req.constraints_md, company_id
    )
    if not company:
        raise HTTPException(status_code=404, detail="Partner company not found")
    return {"status": "success", "company": company}

@app.post("/api/notebooks")
def create_notebook_endpoint(req: NotebookCreateRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Notebook name is required")
    if req.company_id and not db_manager.get_partner_company(req.company_id):
        raise HTTPException(status_code=400, detail="Partner company not found")
    notebook_id = db_manager.create_notebook(
        name,
        [],
        description=req.description,
        knowledge_boundary_md=req.knowledge_boundary_md,
        company_id=req.company_id or "",
        project_brief_md=req.project_brief_md,
    )
    if not notebook_id:
        raise HTTPException(status_code=500, detail="Unable to create notebook")
    return {"status": "success", "notebook_id": notebook_id}

@app.put("/api/notebooks/{notebook_id}")
def update_notebook_project_endpoint(notebook_id: str, req: NotebookProjectUpdateRequest):
    if req.company_id and not db_manager.get_partner_company(req.company_id):
        raise HTTPException(status_code=400, detail="Partner company not found")
    if not db_manager.update_notebook_project(
        notebook_id,
        name=req.name,
        company_id=req.company_id,
        description=req.description,
        project_brief_md=req.project_brief_md,
        knowledge_boundary_md=req.knowledge_boundary_md,
        project_status=req.project_status,
    ):
        raise HTTPException(status_code=404, detail="Project not found or no fields supplied")
    return {"status": "success", "project": db_manager.get_notebook(notebook_id)}

@app.post("/api/notebooks/{notebook_id}/documents/{file_name}")
def add_notebook_document_endpoint(notebook_id: str, file_name: str):
    if not db_manager.add_document_to_notebook(notebook_id, file_name):
        raise HTTPException(status_code=400, detail="Unable to add document to notebook")
    return {"status": "success"}

@app.delete("/api/notebooks/{notebook_id}/documents/{file_name}")
def remove_notebook_document_endpoint(notebook_id: str, file_name: str):
    if not db_manager.remove_document_from_notebook(notebook_id, file_name):
        raise HTTPException(status_code=404, detail="Source is not part of this project")
    return {"status": "success"}

@app.delete("/api/notebooks/{notebook_id}")
def delete_notebook_endpoint(notebook_id: str):
    if not db_manager.delete_notebook(notebook_id):
        raise HTTPException(status_code=404, detail="Notebook not found")
    return {"status": "success"}

@app.get("/api/documents/detail")
def get_document_detail_endpoint(file_name: str = Query(...)):
    """Returns full extracted text and chunk breakdown for document inspection from local SQLite."""
    detail = doc_engine.get_document_details(file_name)
    if not detail:
        raise HTTPException(status_code=404, detail="Document not found.")
    return detail

@app.delete("/api/documents/{file_name}")
def delete_document_endpoint(file_name: str):
    """Deletes a document and its vectors from the local SQLite store."""
    success = db_manager.delete_document(file_name)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to delete document")
    return {"status": "success"}
@app.post("/api/documents/search")
def search_documents_endpoint(req: SearchRequest):
    """Executes semantic vector similarity search across local SQLite sqlite-vec store."""
    results = doc_engine.search_relevant_docs(req.query, top_k=req.top_k or 3)
    return {"query": req.query, "results": results}

@app.get("/api/db/stats")
def db_stats_endpoint():
    """Returns live statistics about the embedded SQLite database."""
    return db_manager.get_db_stats()

background_tasks = set()

class AgentTaskDispatchRequest(BaseModel):
    agent_type: str
    prompt: str
    username: Optional[str] = "mikko"
    project_id: Optional[str] = None
    source_document_names: List[str] = []

@app.post("/api/agents/dispatch")
async def dispatch_agent_task_endpoint(req: AgentTaskDispatchRequest):
    """Executes a task directly on a registered agent/subagent and broadcasts telemetry to WebSockets."""
    agent_obj = agent_registry.get_agent(req.agent_type)
    if not agent_obj:
        if req.agent_type.lower() == "manageragent":
            agent_obj = manager_agent
        else:
            raise HTTPException(status_code=404, detail=f"Agent '{req.agent_type}' not found.")
    
    project_id = (req.project_id or "").strip()
    scoped_sources = db_manager.resolve_notebook_source_scope(project_id, req.source_document_names)
    task = AgentTask(
        task_type=req.agent_type,
        prompt=req.prompt,
        username=req.username or "mikko",
        context={"project_id": project_id, "notebook_ids": [project_id] if project_id else [], "allowed_source_names": scoped_sources},
    )
    import asyncio
    t = asyncio.create_task(agent_obj.execute(task))
    background_tasks.add(t)
    t.add_done_callback(background_tasks.discard)
    return {
        "status": "success",
        "task_id": task.task_id,
        "agent_type": req.agent_type,
        "message": f"Dispatched task to {agent_obj.name}"
    }

@app.post("/api/godmode/skill")
def create_skill_endpoint(req: SkillRequest):
    res = god_mode_engine.register_new_skill(req.name, req.description, req.markdown_body)
    return {"status": "success", "message": res}


# --- Database Dashboard Endpoints ---

@app.get("/api/db/tables")
def get_db_tables():
    return {"tables": db_manager.get_all_tables()}

@app.get("/api/db/tables/{table_name}")
def get_db_table_data(table_name: str, limit: int = 100):
    schema = db_manager.get_table_schema(table_name)
    if not schema:
        raise HTTPException(status_code=404, detail="Unknown table")
    rows = db_manager.get_table_rows(table_name, limit)
    return {"schema": schema, "rows": rows}

@app.delete("/api/db/tables/{table_name}/{pk_col}/{pk_val}")
def delete_db_row(table_name: str, pk_col: str, pk_val: str):
    success = db_manager.delete_table_row(table_name, pk_col, pk_val)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to delete row")
    return {"status": "success"}

@app.put("/api/db/tables/{table_name}/{pk_col}/{pk_val}")
def update_db_row(table_name: str, pk_col: str, pk_val: str, data: Dict[str, Any]):
    success = db_manager.update_table_row(table_name, pk_col, pk_val, data)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to update row")
    return {"status": "success"}

@app.post("/api/db/tables/{table_name}")
def create_db_row(table_name: str, data: Dict[str, Any]):
    if not db_manager.insert_table_row(table_name, data):
        raise HTTPException(status_code=400, detail="Failed to create row")
    return {"status": "success"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await event_bus.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            await websocket.send_json({"type": "ACK", "msg": "Kernel listening"})
    except WebSocketDisconnect:
        event_bus.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        event_bus.disconnect(websocket)

# --- Kanban API Endpoints ---
class KanbanTaskRequest(BaseModel):
    prompt: str
    username: str = "mikko"
    notebook_ids: List[str] = []
    scheduled_time: Optional[str] = None
    timezone: str = "UTC"

class KanbanTaskUpdateRequest(BaseModel):
    prompt: str
    notebook_ids: List[str] = []
    scheduled_time: Optional[str] = None
    timezone: str = "UTC"

class KanbanRerunRequest(BaseModel):
    timezone: str = "UTC"


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _normalise_scheduled_time(value: str) -> str:
    """Accept a timezone-aware time and persist one comparable UTC timestamp."""
    try:
        parsed = datetime.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Scheduled time must be a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise HTTPException(status_code=400, detail="Scheduled time must include a timezone")
    return parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


_DELAYED_TASK_RE = re.compile(
    r"\b(?:in|after)\s+(?P<amount>\d{1,4})\s*(?P<unit>seconds?|minutes?|hours?|days?)\b",
    re.IGNORECASE,
)
_TASK_REQUEST_RE = re.compile(
    r"\b(?:remind|tell|check|monitor|notify|send|run|do|create|prepare|research|find|summari[sz]e|report)\b",
    re.IGNORECASE,
)


def _extract_delayed_task_time(prompt: str) -> Optional[str]:
    """Recognise clear relative agent requests such as 'tell me in 5 minutes'."""
    if not _TASK_REQUEST_RE.search(prompt):
        return None
    match = _DELAYED_TASK_RE.search(prompt)
    if not match:
        return None
    amount = int(match.group("amount"))
    if amount < 1 or amount > 43_200:  # Cap automatic parsing at 30 days.
        return None
    unit = match.group("unit").lower().rstrip("s")
    seconds = amount * {"second": 1, "minute": 60, "hour": 3_600, "day": 86_400}[unit]
    due_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)
    return due_at.isoformat().replace("+00:00", "Z")


kanban_background_tasks = set()


def _launch_kanban_task(task_id: str) -> None:
    background_task = asyncio.create_task(execute_kanban_task(task_id))
    kanban_background_tasks.add(background_task)
    background_task.add_done_callback(kanban_background_tasks.discard)


async def execute_kanban_task(task_id: str) -> None:
    """Run a user-approved Kanban task with its saved project scope."""
    task = db_manager.get_kanban_task(task_id)
    if not task or task.get("status") != "running":
        return
    await event_bus.broadcast("KANBAN_TASK_UPDATED", {"task_id": task_id, "status": "running"})
    await event_bus.notify_workflow_update(task_id, "running", "Manager Agent is executing the Kanban task.")
    try:
        try:
            notebook_ids = json.loads(task.get("notebook_ids_json") or "[]")
        except (TypeError, json.JSONDecodeError):
            notebook_ids = []
        if not isinstance(notebook_ids, list):
            notebook_ids = []
        notebook_ids, scoped_sources, project_id, project_names, business_context = resolve_selected_project_scope(notebook_ids)
        manager_result = await manager_agent.execute(
            AgentTask(
                task_type="kanban_task",
                prompt=task["prompt"],
                username=task.get("username") or "mikko",
                context={
                    "research_mode": "rag_internet",
                    "notebook_ids": notebook_ids,
                    "allowed_source_names": scoped_sources,
                    "project_id": project_id,
                    "project_names": project_names,
                    "business_context": business_context,
                },
            )
        )
        if manager_result.status == "error":
            raise RuntimeError(manager_result.summary)
        response_md = str(manager_result.data.get("response") or manager_result.summary or "")
        summary = " ".join(response_md.split())[:500] or "Task completed without a text response."
        db_manager.update_kanban_task_status(task_id, "done", summary, response_md)
        chat_session_id = str(task.get("chat_session_id") or "")
        if chat_session_id:
            db_manager.append_chat_message(
                chat_session_id,
                task.get("username") or "mikko",
                project_id,
                "assistant",
                response_md,
                {"kind": "scheduled_kanban_result", "task_id": task_id},
            )
        await event_bus.notify_workflow_update(task_id, "completed", "Kanban task completed and archived.")
        await event_bus.broadcast(
            "KANBAN_TASK_UPDATED",
            {"task_id": task_id, "status": "done", "chat_session_id": chat_session_id, "summary": summary},
        )
    except Exception as exc:
        logger.exception("Kanban task %s failed", task_id)
        db_manager.update_kanban_task_status(task_id, "failed", "Task failed. Open the archive for details.", "", str(exc))
        await event_bus.notify_workflow_update(task_id, "failed", "Scheduled task failed; the error was archived.")
        await event_bus.broadcast(
            "KANBAN_TASK_UPDATED",
            {"task_id": task_id, "status": "failed", "chat_session_id": task.get("chat_session_id") or ""},
        )

@app.post("/api/tasks")
def create_kanban_task(req: KanbanTaskRequest):
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Task instructions are required")
    task_id = str(uuid.uuid4())
    schedule_enabled = bool(req.scheduled_time)
    scheduled_time = _normalise_scheduled_time(req.scheduled_time) if req.scheduled_time else _utc_now_iso()
    success = db_manager.add_kanban_task(
        task_id,
        prompt,
        scheduled_time,
        req.timezone,
        username=req.username,
        notebook_ids=req.notebook_ids,
        schedule_enabled=schedule_enabled,
    )
    if success:
        return {
            "status": "pending",
            "task_id": task_id,
            "scheduled_time": scheduled_time,
            "schedule_enabled": schedule_enabled,
        }
    raise HTTPException(status_code=500, detail="Failed to create task")

@app.get("/api/tasks")
def list_kanban_tasks():
    tasks = db_manager.get_all_kanban_tasks()
    return {"tasks": tasks}


@app.get("/api/tasks/{task_id}")
def get_kanban_task(task_id: str):
    task = db_manager.get_kanban_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"task": task, "versions": db_manager.get_kanban_task_versions(task_id)}


@app.delete("/api/tasks/{task_id}")
async def delete_kanban_task(task_id: str):
    if not db_manager.delete_pending_kanban_task(task_id):
        raise HTTPException(status_code=409, detail="Only pending tasks can be deleted")
    await event_bus.broadcast("KANBAN_TASK_UPDATED", {"task_id": task_id, "status": "deleted"})
    return {"status": "deleted"}


@app.post("/api/tasks/{task_id}/run")
async def run_kanban_task_now(task_id: str):
    if not db_manager.start_kanban_task(task_id):
        raise HTTPException(status_code=409, detail="Only pending tasks can be started")
    _launch_kanban_task(task_id)
    await event_bus.broadcast("KANBAN_TASK_UPDATED", {"task_id": task_id, "status": "running"})
    return {"status": "running", "task_id": task_id}


@app.post("/api/tasks/{task_id}/rerun")
async def rerun_kanban_task(task_id: str, req: KanbanRerunRequest):
    timezone_name = req.timezone[:100] or "UTC"
    new_task_id = str(uuid.uuid4())
    rerun = db_manager.create_kanban_rerun(task_id, new_task_id, _utc_now_iso(), timezone_name)
    if not rerun:
        raise HTTPException(status_code=409, detail="Only archived tasks can be rerun")
    await event_bus.broadcast("KANBAN_TASK_UPDATED", {"task_id": new_task_id, "status": "pending"})
    return {"status": "pending", "task_id": new_task_id, "version": rerun["version"]}

@app.patch("/api/tasks/{task_id}")
async def update_kanban_task(task_id: str, req: KanbanTaskUpdateRequest):
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Task instructions are required")
    schedule_enabled = bool(req.scheduled_time)
    scheduled_time = _normalise_scheduled_time(req.scheduled_time) if req.scheduled_time else _utc_now_iso()
    task = db_manager.update_pending_kanban_task(
        task_id,
        prompt=prompt,
        scheduled_time=scheduled_time,
        scheduled_timezone=req.timezone,
        schedule_enabled=schedule_enabled,
        notebook_ids=req.notebook_ids,
    )
    if not task:
        raise HTTPException(status_code=409, detail="Only pending tasks can be edited")
    await event_bus.broadcast("KANBAN_TASK_UPDATED", {"task_id": task_id, "status": "pending"})
    return {"status": "pending", "task": task}


# Persistent cron-like scheduler. Task timing is stored in SQLite, so a server
# restart does not lose pending schedules; the loop simply resumes claiming due work.
async def background_kanban_scheduler():
    while True:
        try:
            for task_id in db_manager.list_due_scheduled_kanban_tasks(_utc_now_iso()):
                if db_manager.start_kanban_task(task_id):
                    _launch_kanban_task(task_id)
                    await event_bus.broadcast("KANBAN_TASK_UPDATED", {"task_id": task_id, "status": "running"})
        except Exception as exc:
            logger.exception("Kanban scheduler failed: %s", exc)
        await asyncio.sleep(1)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(background_kanban_scheduler())

