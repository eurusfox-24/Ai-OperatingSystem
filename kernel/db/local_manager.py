import os
import sqlite3
import struct
import time
import logging
import json
from typing import Optional, Dict, Any, List

logger = logging.getLogger("local_db_manager")

# Attempt to load sqlite-vec extension for local vector search
try:
    import sqlite_vec
    HAS_SQLITE_VEC = True
except ImportError:
    HAS_SQLITE_VEC = False
    logger.warning("sqlite-vec not installed. Vector search will use in-memory fallback.")

DB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))
DB_PATH = os.path.join(DB_DIR, "kernel_workspace.db")


def _serialize_float32(vec: List[float]) -> bytes:
    """Serialize a list of floats into a compact binary blob for sqlite-vec vec0 virtual tables."""
    return struct.pack(f"{len(vec)}f", *vec)


class LocalDBManager:
    """Embedded SQLite controller managing all persistent data for the AI OS kernel.

    Handles agent profiles (soul_md, rules_md), user profiles, document metadata,
    text chunks, and 1536-dim vector embeddings via sqlite-vec vec0 virtual tables.
    Database file: data/kernel_workspace.db
    """

    def __init__(self):
        os.makedirs(DB_DIR, exist_ok=True)
        self.db_path = DB_PATH
        self.is_initialized = False
        self._init_database()

    def _get_connection(self) -> sqlite3.Connection:
        """Returns a new connection with sqlite-vec loaded (if available)."""
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        if HAS_SQLITE_VEC:
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
        return conn

    def _init_database(self):
        """Creates all core tables and vec0 virtual tables on first run."""
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.cursor()

            # Agent profiles table (soul_md + rules_md + model config)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS agent_profiles (
                    agent_id TEXT PRIMARY KEY,
                    agent_name TEXT NOT NULL DEFAULT '',
                    role_label TEXT NOT NULL DEFAULT '',
                    soul_md TEXT NOT NULL DEFAULT '',
                    rules_md TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'azure',
                    model TEXT NOT NULL DEFAULT 'mvp-gpt-54-mini',
                    temperature REAL NOT NULL DEFAULT 0.7,
                    max_tokens INTEGER NOT NULL DEFAULT 1500,
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # User profiles table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_profiles (
                    user_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL DEFAULT '',
                    profile_md TEXT NOT NULL DEFAULT '',
                    tone_style TEXT NOT NULL DEFAULT 'formal_executive',
                    custom_instructions TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # Document metadata table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    file_name TEXT PRIMARY KEY,
                    extension TEXT,
                    size_bytes INTEGER,
                    text_length INTEGER,
                    chunks_indexed INTEGER DEFAULT 0,
                    storage_path TEXT,
                    ai_summary TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # Document text chunks table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS document_chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_name TEXT NOT NULL REFERENCES documents(file_name) ON DELETE CASCADE,
                    chunk_index INTEGER NOT NULL DEFAULT 0,
                    text_content TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # Project workspaces (kept in the existing notebooks table for a
            # backwards-compatible API). A project is the permission boundary
            # for its shared knowledge, task history, and agent context.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS notebooks (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    company_id TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    project_brief_md TEXT NOT NULL DEFAULT '',
                    knowledge_boundary_md TEXT NOT NULL DEFAULT '',
                    project_status TEXT NOT NULL DEFAULT 'active',
                    briefing_doc_md TEXT DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # Business context is deliberately small and readable. Forest
            # Joensuu's DNA is shared operating context; partner/company and
            # project records narrow it for the work currently selected.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS organization_context (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    mission_md TEXT NOT NULL DEFAULT '',
                    priorities_md TEXT NOT NULL DEFAULT '',
                    constraints_md TEXT NOT NULL DEFAULT '',
                    decision_principles_md TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS partner_companies (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    context_md TEXT NOT NULL DEFAULT '',
                    priorities_md TEXT NOT NULL DEFAULT '',
                    constraints_md TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            cur.execute("""
                INSERT OR IGNORE INTO organization_context (id, name)
                VALUES ('forest_joensuu', 'Forest Joensuu')
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS notebook_documents (
                    notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
                    doc_name TEXT NOT NULL REFERENCES documents(file_name) ON DELETE CASCADE,
                    PRIMARY KEY (notebook_id, doc_name)
                )
            """)

            # Agent memories table (persistent workspace context)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS agent_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id TEXT NOT NULL,
                    user_id TEXT NOT NULL DEFAULT 'alex',
                    project_id TEXT NOT NULL DEFAULT '',
                    memory_md TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # Agent procedural skills table (conditional runbooks)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS agent_skills (
                    skill_id TEXT PRIMARY KEY,
                    trigger_keywords TEXT NOT NULL,
                    runbook_md TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # Kanban tasks are explicitly started by the user from the board.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS kanban_tasks (
                    id TEXT PRIMARY KEY,
                    prompt TEXT NOT NULL,
                    scheduled_time TEXT NOT NULL,
                    scheduled_timezone TEXT NOT NULL DEFAULT 'UTC',
                    status TEXT NOT NULL DEFAULT 'pending',
                    result_summary TEXT DEFAULT '',
                    result_md TEXT NOT NULL DEFAULT '',
                    error_message TEXT NOT NULL DEFAULT '',
                    root_task_id TEXT NOT NULL DEFAULT '',
                    parent_task_id TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 1,
                    username TEXT NOT NULL DEFAULT 'alex',
                    notebook_ids_json TEXT NOT NULL DEFAULT '[]',
                    schedule_enabled INTEGER NOT NULL DEFAULT 0,
                    chat_session_id TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    ,started_at TEXT
                    ,completed_at TEXT
                )
            """)

            # ChatGPT-style conversations are kept separate from the project
            # memory.  A session belongs to exactly one user/project pair and
            # carries an optional compact recap for bounded model context.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL DEFAULT 'alex',
                    project_id TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT 'New chat',
                    summary_md TEXT NOT NULL DEFAULT '',
                    summary_through_message_id INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    content_md TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

            # Autonomous research is deliberately persisted as an auditable task
            # trail. The runner may read notebooks and public web pages without
            # further input, but it never gains arbitrary host/browser/write access.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS autonomous_tasks (
                    id TEXT PRIMARY KEY,
                    task_type TEXT NOT NULL DEFAULT 'deep_research',
                    query TEXT NOT NULL,
                    username TEXT NOT NULL DEFAULT 'alex',
                    notebook_ids_json TEXT NOT NULL DEFAULT '[]',
                    source_doc_names_json TEXT NOT NULL DEFAULT '[]',
                    max_web_sources INTEGER NOT NULL DEFAULT 3,
                    status TEXT NOT NULL DEFAULT 'queued',
                    plan_json TEXT NOT NULL DEFAULT '[]',
                    context_json TEXT NOT NULL DEFAULT '{}',
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    cancel_reason TEXT NOT NULL DEFAULT '',
                    last_action TEXT NOT NULL DEFAULT '',
                    result_md TEXT NOT NULL DEFAULT '',
                    error_message TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    started_at TEXT,
                    completed_at TEXT
                )
            """)

            # SQLite CREATE TABLE does not update existing installations. These
            # additive migrations retain every current project/document while
            # making project scope and memory isolation explicit.
            self._ensure_column(cur, "notebooks", "description", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "notebooks", "company_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "notebooks", "project_brief_md", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "notebooks", "knowledge_boundary_md", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "notebooks", "project_status", "TEXT NOT NULL DEFAULT 'active'")
            self._ensure_column(cur, "notebooks", "updated_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "agent_memories", "project_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "autonomous_tasks", "source_doc_names_json", "TEXT NOT NULL DEFAULT '[]'")
            self._ensure_column(cur, "autonomous_tasks", "context_json", "TEXT NOT NULL DEFAULT '{}'")
            self._ensure_column(cur, "autonomous_tasks", "cancel_requested", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(cur, "autonomous_tasks", "cancel_reason", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "autonomous_tasks", "last_action", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "chat_sessions", "summary_md", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "chat_sessions", "summary_through_message_id", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(cur, "kanban_tasks", "scheduled_timezone", "TEXT NOT NULL DEFAULT 'UTC'")
            self._ensure_column(cur, "kanban_tasks", "result_md", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "kanban_tasks", "error_message", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "kanban_tasks", "root_task_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "kanban_tasks", "parent_task_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "kanban_tasks", "version", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(cur, "kanban_tasks", "username", "TEXT NOT NULL DEFAULT 'alex'")
            self._ensure_column(cur, "kanban_tasks", "notebook_ids_json", "TEXT NOT NULL DEFAULT '[]'")
            self._ensure_column(cur, "kanban_tasks", "schedule_enabled", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(cur, "kanban_tasks", "chat_session_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(cur, "kanban_tasks", "started_at", "TEXT")
            self._ensure_column(cur, "kanban_tasks", "completed_at", "TEXT")
            cur.execute("UPDATE kanban_tasks SET root_task_id = id WHERE root_task_id = ''")
            cur.execute("UPDATE kanban_tasks SET status = 'pending' WHERE status = 'run'")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS autonomous_task_steps (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL REFERENCES autonomous_tasks(id) ON DELETE CASCADE,
                    step_index INTEGER NOT NULL,
                    tool_name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    input_summary TEXT NOT NULL DEFAULT '',
                    output_summary TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    completed_at TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS research_artifacts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL REFERENCES autonomous_tasks(id) ON DELETE CASCADE,
                    artifact_type TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    content_md TEXT NOT NULL DEFAULT '',
                    sources_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS autonomous_approvals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL REFERENCES autonomous_tasks(id) ON DELETE CASCADE,
                    action_name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    requested_summary TEXT NOT NULL DEFAULT '',
                    decided_by TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    decided_at TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS autonomous_task_controls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL REFERENCES autonomous_tasks(id) ON DELETE CASCADE,
                    control_type TEXT NOT NULL CHECK(control_type IN ('steer', 'stop')),
                    content_md TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    applied_at TEXT
                )
            """)

            # Vector embeddings virtual table (for sqlite-vec 1536-dim embeddings)
            if HAS_SQLITE_VEC:
                cur.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS vec_document_chunks USING vec0(
                        chunk_id INTEGER PRIMARY KEY,
                        embedding float[1536]
                    )
                """)

            cur.execute("CREATE INDEX IF NOT EXISTS idx_document_chunks_doc_name ON document_chunks(doc_name)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_user_project ON agent_memories(agent_id, user_id, project_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_project_updated ON chat_sessions(user_id, project_id, updated_at DESC)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id, id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_kanban_tasks_root_version ON kanban_tasks(root_task_id, version)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_status ON autonomous_tasks(status)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_autonomous_task_steps_task ON autonomous_task_steps(task_id, step_index)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_research_artifacts_task ON research_artifacts(task_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_autonomous_task_controls_task ON autonomous_task_controls(task_id, id)")

            conn.commit()

            # Auto-seed default agent profiles if missing/empty
            self._seed_default_agent_profiles(cur)
            conn.commit()
            self.is_initialized = True
            logger.info(f"Embedded SQLite database initialized at {self.db_path} (sqlite-vec: {HAS_SQLITE_VEC})")
        except Exception as e:
            logger.error(f"Failed to initialize SQLite database: {e}")
            self.is_initialized = False
        finally:
            if conn:
                conn.close()

    @staticmethod
    def _ensure_column(cursor: sqlite3.Cursor, table: str, column: str, definition: str) -> None:
        """Adds a backwards-compatible column only when an older local DB lacks it."""
        columns = {row["name"] for row in cursor.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def _seed_default_agent_profiles(self, cur: sqlite3.Cursor):
        """Auto-seeds default agent profiles (soul_md + rules_md) if agent_profiles table is unpopulated."""
        defaults = [
            {
                "agent_id": "ManagerAgent",
                "agent_name": "Manager Agent",
                "role_label": "Executive Assistant & Chat Hub",
                "soul_md": "You are the Executive General Manager and Lead AI Personal Assistant for Forest Joensuu and Business Joensuu.\n\nYOUR PERSONA & TONE:\n- You operate with the poise, intelligence, courtesy, and executive presence of an elite General Manager at a top-tier luxury establishment.\n- Communication Tone: Formal, polite, highly structured, professional, and authoritative yet warm and accommodating.\n- Mindset: You are an expert orchestrator and coordinator. You take full ownership of assisting the user with executive decisions, strategic plans, writing, and operational guidance.",
                "rules_md": "DELEGATION & SUB-AGENT TASKFORCE PROTOCOL:\nYou manage a specialized board of domain-expert sub-agents:\n1. Financial Advisor Agent: CFO-level corporate finance, capital burn rate, runway modeling, ROI risks, and grant structuring.\n2. Meeting Secretary Agent: Executive meeting minutes, action item tracking, and vector search.\n3. Foresight Radar Agent: Chief Intelligence Officer scanning global bioeconomy trends, news, and live web market radar.\n4. Impact Evaluator Agent: Quantitative project proposal scoring, job creation ratio, and net-zero roadmap feasibility.\n5. Susicorn Accelerator Agent: Venture capital dealflow matching, green startup acceleration ('Susicorns'), and private-sector job growth.\n\nPROTOCOL:\nWhen specialized execution is requested, allocate the best expert sub-agent, receive their report, synthesize findings, and present an authoritative executive summary.",
                "color": "#10b981"
            },
            {
                "agent_id": "FinancialAdvisorAgent",
                "agent_name": "Financial Advisor",
                "role_label": "Financial Strategy & Capital Allocation",
                "soul_md": "You are the Chief Financial Officer (CFO) & Senior Investment Strategist sub-agent for Forest Joensuu and Business Joensuu.\n\nYOUR PERSONA & TONE:\n- Tone: Analytical, precise, formal, empirical, and financially rigorous.\n- Perspective: You view every initiative through the lens of capital efficiency, cash burn rate, runway extension, ROI risk modeling, and regional economic leverage.",
                "rules_md": "EXECUTION DIRECTIVE:\nWhen tasked with financial advisories, conduct a thorough quantitative assessment:\n1. Executive Financial Health Assessment (Cash flow, capital burn, runway)\n2. Investment & Regional Grant Structuring (Joensuu bio-fund, EU innovation grants, VC co-investment)\n3. ROI & Financial Risk Modeling\n4. Recommended Immediate Financial Actions (Next 30/90 Days)",
                "color": "#2196F3"
            },
            {
                "agent_id": "MeetingNotesAgent",
                "agent_name": "Meeting Secretary",
                "role_label": "RAG Ingestion & Meeting Analytics",
                "soul_md": "You are the Chief Secretary & RAG Ingestion Officer sub-agent for Forest Joensuu and Business Joensuu.\n\nYOUR PERSONA & TONE:\n- Tone: Concise, highly organized, detail-oriented, and structured.\n- Perspective: You excel at extracting action items, key decisions, owner assignments, and deadlines from raw meeting notes and board transcripts.",
                "rules_md": "EXECUTION DIRECTIVE:\nWhen processing meeting notes or transcripts:\n1. Executive Summary (Key themes & outcomes)\n2. Decided Action Items (Task, Assigned Lead, Deadline)\n3. Strategic Risks & Follow-up Agenda",
                "color": "#9C27B0"
            },
            {
                "agent_id": "ForesightAgent",
                "agent_name": "Foresight Radar",
                "role_label": "Global Market Radar & Bioeconomy Intelligence",
                "soul_md": "You are the Chief Intelligence Officer & Market Foresight Radar sub-agent for Forest Joensuu and Business Joensuu.\n\nYOUR PERSONA & TONE:\n- Tone: Forward-looking, strategic, radar-focused, and competitive intelligence-driven.\n- Perspective: You track macro trends, bioeconomy technologies, carbon policy regulations, and competitive movements in Joensuu and North Karelia.",
                "rules_md": "EXECUTION DIRECTIVE:\nWhen conducting market foresight or intelligence scans:\n1. Macro Market Trend Radar\n2. Regulatory & Bioeconomy Shifts\n3. Competitive Threats & Strategic Opportunities",
                "color": "#FF9800"
            },
            {
                "agent_id": "IdeaScorerAgent",
                "agent_name": "Impact Evaluator",
                "role_label": "Quantitative Project Scoring & Job Creation Impact",
                "soul_md": "You are the Chief Investment Officer & Impact Evaluator sub-agent for Business Joensuu.\n\nYOUR PERSONA & TONE:\n- Tone: Quantitative, objective, scorecard-based, and evidence-driven.\n- Perspective: You score project proposals, startup pitches, and grant applications on regional job creation impact, Susicorn potential, and technical feasibility.",
                "rules_md": "EXECUTION DIRECTIVE:\nScore proposals on a 1-10 scale across:\n1. Strategic Fit with Joensuu Strategy 2026\n2. Regional Job Creation & Economic Output\n3. Net-Zero & Sustainability Impact\n4. Execution Risk & Feasibility",
                "color": "#E91E63"
            },
            {
                "agent_id": "SusicornAgent",
                "agent_name": "Susicorn Accelerator",
                "role_label": "Venture Acceleration & Startup Job Growth",
                "soul_md": "You are the Head of Susicorn Acceleration & VC Scaling sub-agent for Business Joensuu.\n\nYOUR PERSONA & TONE:\n- Tone: High-energy, venture capital-minded, scaling-focused, and proactive.\n- Perspective: You focus on accelerating sustainable tech startups ('Susicorns') in Joensuu, scaling private sector jobs, and matching startups with Nordic VC funds.",
                "rules_md": "EXECUTION DIRECTIVE:\nWhen evaluating or scaling Susicorn startups:\n1. Startup Readiness Score & Growth Trajectory\n2. VC Capital Match & Funding Pathway\n3. Joensuu Job Creation Impact Model\n4. 90-Day Acceleration Roadmap",
                "color": "#00BCD4"
            }
        ]

        for item in defaults:
            cur.execute("""
                INSERT INTO agent_profiles (agent_id, agent_name, role_label, soul_md, rules_md, provider, model, temperature, max_tokens)
                VALUES (?, ?, ?, ?, ?, 'azure', 'mvp-gpt-54-mini', 0.7, 1500)
                ON CONFLICT(agent_id) DO UPDATE SET
                    agent_name = excluded.agent_name,
                    role_label = excluded.role_label,
                    soul_md = CASE WHEN agent_profiles.soul_md = '' THEN excluded.soul_md ELSE agent_profiles.soul_md END,
                    rules_md = CASE WHEN agent_profiles.rules_md = '' THEN excluded.rules_md ELSE agent_profiles.rules_md END
            """, (item["agent_id"], item["agent_name"], item["role_label"], item["soul_md"], item["rules_md"]))
        # Repair profiles pointing to providers or deployments that are not in
        # this Azure resource, while preserving valid user-selected deployments.
        cur.execute(
            """
            UPDATE agent_profiles
            SET provider = 'azure', model = 'mvp-gpt-54-mini'
            WHERE provider != 'azure'
               OR model NOT IN (
                   'mvp-mini', 'mvp-gpt-54', 'mvp-gpt-55', 'mvp-gpt-54-mini',
                   'mvp-gpt-54-nano', 'mvp-gpt-5-mini', 'mvp-gpt-5-nano'
               )
            """
        )
        logger.info("Auto-seeded default agent profiles (soul_md + rules_md) into SQLite database.")

    # =========================================================================
    # AGENT PROFILES CRUD
    # =========================================================================

    def save_agent_profile(
        self,
        agent_id: str,
        agent_name: str = "",
        role_label: str = "",
        soul_md: str = "",
        rules_md: str = "",
        provider: str = "azure",
        model: str = "mvp-gpt-54-mini",
        temperature: float = 0.7,
        max_tokens: int = 1500
    ) -> Dict[str, Any]:
        """Upserts an agent profile into the local SQLite agent_profiles table."""
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            conn = self._get_connection()
            conn.execute("""
                INSERT INTO agent_profiles (agent_id, agent_name, role_label, soul_md, rules_md, provider, model, temperature, max_tokens, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                    agent_name = COALESCE(NULLIF(excluded.agent_name, ''), agent_profiles.agent_name),
                    role_label = COALESCE(NULLIF(excluded.role_label, ''), agent_profiles.role_label),
                    soul_md = CASE WHEN excluded.soul_md != '' THEN excluded.soul_md ELSE agent_profiles.soul_md END,
                    rules_md = CASE WHEN excluded.rules_md != '' THEN excluded.rules_md ELSE agent_profiles.rules_md END,
                    provider = excluded.provider,
                    model = excluded.model,
                    temperature = excluded.temperature,
                    max_tokens = excluded.max_tokens,
                    updated_at = excluded.updated_at
            """, (agent_id, agent_name, role_label, soul_md, rules_md, provider, model, temperature, max_tokens, timestamp))
            conn.commit()
            conn.close()
            logger.info(f"Saved agent profile for '{agent_id}' to local SQLite.")
            return {
                "status": "success",
                "db_status": "Saved & Persisted in Local Embedded SQLite (agent_profiles table)",
                "updated_at": timestamp
            }
        except Exception as e:
            logger.error(f"Error saving agent profile for '{agent_id}': {e}")
            return {
                "status": "error",
                "db_status": f"SQLite save error: {str(e)}",
                "updated_at": timestamp
            }

    def get_agent_profile(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Fetches a single agent profile from the local SQLite agent_profiles table."""
        try:
            conn = self._get_connection()
            row = conn.execute("SELECT * FROM agent_profiles WHERE agent_id = ?", (agent_id,)).fetchone()
            conn.close()
            if row:
                return dict(row)
            return None
        except Exception as e:
            logger.error(f"Error fetching agent profile '{agent_id}': {e}")
            return None

    def get_all_agent_profiles(self) -> Dict[str, Dict[str, Any]]:
        """Fetches all agent profiles from the local SQLite agent_profiles table."""
        result = {}
        try:
            conn = self._get_connection()
            rows = conn.execute("SELECT * FROM agent_profiles ORDER BY agent_id").fetchall()
            conn.close()
            for row in rows:
                d = dict(row)
                result[d["agent_id"]] = d
        except Exception as e:
            logger.error(f"Error fetching all agent profiles: {e}")
        return result

    # =========================================================================
    # USER PROFILES CRUD
    # =========================================================================

    def save_user_profile(
        self,
        user_id: str,
        display_name: str = "",
        role: str = "",
        profile_md: str = "",
        tone_style: str = "formal_executive",
        custom_instructions: str = ""
    ) -> Dict[str, Any]:
        """Upserts a user profile into the local SQLite user_profiles table."""
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            conn = self._get_connection()
            conn.execute("""
                INSERT INTO user_profiles (user_id, display_name, role, profile_md, tone_style, custom_instructions, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    display_name = COALESCE(NULLIF(excluded.display_name, ''), user_profiles.display_name),
                    role = COALESCE(NULLIF(excluded.role, ''), user_profiles.role),
                    profile_md = CASE WHEN excluded.profile_md != '' THEN excluded.profile_md ELSE user_profiles.profile_md END,
                    tone_style = excluded.tone_style,
                    custom_instructions = excluded.custom_instructions,
                    updated_at = excluded.updated_at
            """, (user_id, display_name, role, profile_md, tone_style, custom_instructions, timestamp))
            conn.commit()
            conn.close()
            return {"status": "success", "updated_at": timestamp}
        except Exception as e:
            logger.error(f"Error saving user profile '{user_id}': {e}")
            return {"status": "error", "message": str(e)}

    def get_user_profile(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Fetches a single user profile from the local SQLite user_profiles table."""
        try:
            conn = self._get_connection()
            row = conn.execute("SELECT * FROM user_profiles WHERE user_id = ?", (user_id,)).fetchone()
            conn.close()
            if row:
                return dict(row)
            return None
        except Exception as e:
            logger.error(f"Error fetching user profile '{user_id}': {e}")
            return None

    # =========================================================================
    # AGENT MEMORIES & SKILLS CRUD
    # =========================================================================

    def get_agent_memory(self, agent_id: str, user_id: str = "alex", project_id: str = "") -> Optional[str]:
        """Fetches persistent workspace memory scoped to an agent, user, and project."""
        try:
            conn = self._get_connection()
            row = conn.execute(
                "SELECT memory_md FROM agent_memories WHERE agent_id = ? AND user_id = ? AND project_id = ? ORDER BY id DESC LIMIT 1",
                (agent_id, user_id, project_id or "")
            ).fetchone()
            conn.close()
            if row:
                return row["memory_md"]
            return None
        except Exception as e:
            logger.error(f"Error fetching memory for {agent_id}/{user_id}/{project_id}: {e}")
            return None

    def save_agent_memory(self, agent_id: str, user_id: str, memory_md: str, project_id: str = "") -> Dict[str, Any]:
        """Saves a persistent workspace memory entry without crossing project boundaries."""
        try:
            conn = self._get_connection()
            conn.execute(
                "INSERT INTO agent_memories (agent_id, user_id, project_id, memory_md) VALUES (?, ?, ?, ?)",
                (agent_id, user_id, project_id or "", memory_md)
            )
            conn.commit()
            conn.close()
            return {"status": "success"}
        except Exception as e:
            logger.error(f"Error saving agent memory: {e}")
            return {"status": "error", "message": str(e)}

    # =========================================================================
    # USER CHAT SESSIONS
    # =========================================================================

    @staticmethod
    def _normalise_chat_title(value: str) -> str:
        """Produces a short, stable session title without spending an LLM call."""
        cleaned = " ".join((value or "").split())
        if not cleaned:
            return "New chat"
        return cleaned[:80] + ("…" if len(cleaned) > 80 else "")

    def create_chat_session(self, user_id: str, project_id: str, title: str = "New chat") -> Dict[str, Any]:
        """Creates one user-owned conversation.

        project_id is retained as creation-time provenance for existing data,
        but it does not control which conversation is active or visible.
        """
        import uuid

        session_id = f"chat_{uuid.uuid4().hex[:12]}"
        conn = None
        try:
            conn = self._get_connection()
            conn.execute(
                """
                INSERT INTO chat_sessions (id, user_id, project_id, title, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                """,
                (session_id, user_id or "alex", project_id or "", self._normalise_chat_title(title)),
            )
            conn.commit()
            return self.get_chat_session(session_id, user_id, project_id) or {}
        except Exception as e:
            logger.error(f"Error creating chat session for {user_id}/{project_id}: {e}")
            return {}
        finally:
            if conn:
                conn.close()

    def get_chat_session(self, session_id: str, user_id: str, project_id: str) -> Optional[Dict[str, Any]]:
        """Fetches a session when it belongs to the requested user.

        project_id remains in the signature for backwards compatibility only;
        knowledge scope is chosen per Manager request, not per conversation.
        """
        conn = None
        try:
            conn = self._get_connection()
            row = conn.execute(
                """
                SELECT s.*, COUNT(m.id) AS message_count
                FROM chat_sessions AS s
                LEFT JOIN chat_messages AS m ON m.session_id = s.id
                WHERE s.id = ? AND s.user_id = ?
                GROUP BY s.id
                """,
                (session_id, user_id or "alex"),
            ).fetchone()
            return dict(row) if row else None
        except Exception as e:
            logger.error(f"Error fetching chat session {session_id}: {e}")
            return None
        finally:
            if conn:
                conn.close()

    def list_chat_sessions(self, user_id: str, project_id: str, limit: int = 80) -> List[Dict[str, Any]]:
        """Lists all conversation cards for one user, independent of knowledge scope."""
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute(
                """
                SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
                FROM chat_sessions AS s
                LEFT JOIN chat_messages AS m ON m.session_id = s.id
                WHERE s.user_id = ?
                GROUP BY s.id
                ORDER BY s.updated_at DESC, s.created_at DESC
                LIMIT ?
                """,
                (user_id or "alex", max(1, min(limit, 200))),
            ).fetchall()
            return [dict(row) for row in rows]
        except Exception as e:
            logger.error(f"Error listing chat sessions for {user_id}: {e}")
            return []
        finally:
            if conn:
                conn.close()

    def get_chat_session_messages(
        self, session_id: str, user_id: str, project_id: str, limit: int = 300
    ) -> Optional[List[Dict[str, Any]]]:
        """Returns display history in chronological order after validating user ownership."""
        if not self.get_chat_session(session_id, user_id, project_id):
            return None
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute(
                """
                SELECT id, role, content_md, metadata_json, created_at
                FROM chat_messages
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, max(1, min(limit, 1000))),
            ).fetchall()
            messages = []
            for row in reversed(rows):
                message = dict(row)
                try:
                    message["metadata"] = json.loads(message.pop("metadata_json") or "{}")
                except json.JSONDecodeError:
                    message["metadata"] = {}
                messages.append(message)
            return messages
        except Exception as e:
            logger.error(f"Error fetching chat messages for {session_id}: {e}")
            return None
        finally:
            if conn:
                conn.close()

    def get_chat_session_context(
        self, session_id: str, user_id: str, project_id: str, limit: int = 12
    ) -> Optional[Dict[str, Any]]:
        """Gets only the current compact recap and recent unsummarised turns for LLM context."""
        session = self.get_chat_session(session_id, user_id, project_id)
        if not session:
            return None
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute(
                """
                SELECT id, role, content_md
                FROM chat_messages
                WHERE session_id = ? AND id > ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, int(session.get("summary_through_message_id") or 0), max(1, min(limit, 50))),
            ).fetchall()
            session["messages"] = [dict(row) for row in reversed(rows)]
            return session
        except Exception as e:
            logger.error(f"Error building chat context for {session_id}: {e}")
            return None
        finally:
            if conn:
                conn.close()

    def append_chat_message(
        self,
        session_id: str,
        user_id: str,
        project_id: str,
        role: str,
        content_md: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[int]:
        """Appends an auditable user/assistant turn and refreshes the session card timestamp."""
        if role not in {"user", "assistant"} or not content_md.strip():
            return None
        conn = None
        try:
            conn = self._get_connection()
            session = conn.execute(
                "SELECT s.title, COUNT(m.id) AS message_count FROM chat_sessions AS s LEFT JOIN chat_messages AS m ON m.session_id = s.id WHERE s.id = ? AND s.user_id = ? GROUP BY s.id",
                (session_id, user_id or "alex"),
            ).fetchone()
            if not session:
                return None
            cur = conn.execute(
                """
                INSERT INTO chat_messages (session_id, role, content_md, metadata_json)
                VALUES (?, ?, ?, ?)
                """,
                (session_id, role, content_md, json.dumps(metadata or {}, ensure_ascii=False)),
            )
            if role == "user" and int(session["message_count"] or 0) == 0:
                conn.execute(
                    "UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?",
                    (self._normalise_chat_title(content_md), session_id),
                )
            else:
                conn.execute("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?", (session_id,))
            conn.commit()
            return int(cur.lastrowid)
        except Exception as e:
            logger.error(f"Error appending chat message for {session_id}: {e}")
            return None
        finally:
            if conn:
                conn.close()

    def get_chat_compaction_candidate(
        self, session_id: str, user_id: str, project_id: str, keep_recent: int = 12, trigger_at: int = 18
    ) -> Optional[Dict[str, Any]]:
        """Returns older, not-yet-recaped turns only when a session needs compaction."""
        session = self.get_chat_session(session_id, user_id, project_id)
        if not session:
            return None
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute(
                """
                SELECT id, role, content_md
                FROM chat_messages
                WHERE session_id = ? AND id > ?
                ORDER BY id ASC
                """,
                (session_id, int(session.get("summary_through_message_id") or 0)),
            ).fetchall()
            if len(rows) < trigger_at:
                return None
            compact_rows = rows[: max(1, len(rows) - keep_recent)]
            return {
                "summary_md": session.get("summary_md", ""),
                "messages": [dict(row) for row in compact_rows],
                "through_message_id": compact_rows[-1]["id"],
            }
        except Exception as e:
            logger.error(f"Error preparing chat session compaction for {session_id}: {e}")
            return None
        finally:
            if conn:
                conn.close()

    def update_chat_session_summary(
        self, session_id: str, user_id: str, project_id: str, summary_md: str, through_message_id: int
    ) -> bool:
        """Atomically advances a session recap cursor without removing visible chat history."""
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute(
                """
                UPDATE chat_sessions
                SET summary_md = ?, summary_through_message_id = ?, updated_at = datetime('now')
                WHERE id = ? AND user_id = ?
                """,
                (summary_md.strip()[:12000], through_message_id, session_id, user_id or "alex"),
            )
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            logger.error(f"Error saving chat recap for {session_id}: {e}")
            return False
        finally:
            if conn:
                conn.close()

    def delete_chat_session(self, session_id: str, user_id: str, project_id: str) -> bool:
        """Deletes one user-selected conversation."""
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute(
                "DELETE FROM chat_sessions WHERE id = ? AND user_id = ?",
                (session_id, user_id or "alex"),
            )
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            logger.error(f"Error deleting chat session {session_id}: {e}")
            return False
        finally:
            if conn:
                conn.close()

    def get_matching_skills(self, query_text: str) -> List[Dict[str, Any]]:
        """Finds procedural skills whose trigger_keywords match terms in the query_text."""
        if not query_text:
            return []
        matched = []
        lower_q = query_text.lower()
        try:
            conn = self._get_connection()
            rows = conn.execute("SELECT * FROM agent_skills").fetchall()
            conn.close()
            for r in rows:
                skill = dict(r)
                keywords = [kw.strip().lower() for kw in skill.get("trigger_keywords", "").split(",") if kw.strip()]
                if any(kw in lower_q for kw in keywords):
                    matched.append(skill)
        except Exception as e:
            logger.error(f"Error checking matching skills: {e}")
        return matched

    def save_agent_skill(self, skill_id: str, trigger_keywords: str, runbook_md: str) -> Dict[str, Any]:
        """Upserts a procedural skill runbook into SQLite agent_skills table."""
        try:
            conn = self._get_connection()
            conn.execute("""
                INSERT INTO agent_skills (skill_id, trigger_keywords, runbook_md)
                VALUES (?, ?, ?)
                ON CONFLICT(skill_id) DO UPDATE SET
                    trigger_keywords = excluded.trigger_keywords,
                    runbook_md = excluded.runbook_md
            """, (skill_id, trigger_keywords, runbook_md))
            conn.commit()
            conn.close()
            return {"status": "success"}
        except Exception as e:
            logger.error(f"Error saving agent skill '{skill_id}': {e}")
            return {"status": "error", "message": str(e)}

    # =========================================================================
    # PROJECT WORKSPACES (backwards-compatible notebook API)
    # =========================================================================

    # =========================================================================
    # BUSINESS CONTEXT (Forest Joensuu -> partner company -> project)
    # =========================================================================

    def get_organization_context(self) -> Dict[str, Any]:
        conn = None
        try:
            conn = self._get_connection()
            row = conn.execute(
                "SELECT * FROM organization_context WHERE id = 'forest_joensuu'"
            ).fetchone()
            return dict(row) if row else {"id": "forest_joensuu", "name": "Forest Joensuu"}
        except Exception as exc:
            logger.error("Error loading Forest Joensuu context: %s", exc)
            return {"id": "forest_joensuu", "name": "Forest Joensuu"}
        finally:
            if conn:
                conn.close()

    def save_organization_context(
        self,
        name: str,
        mission_md: str,
        priorities_md: str,
        constraints_md: str,
        decision_principles_md: str,
    ) -> Dict[str, Any]:
        conn = None
        try:
            conn = self._get_connection()
            conn.execute(
                """
                INSERT INTO organization_context
                    (id, name, mission_md, priorities_md, constraints_md, decision_principles_md, updated_at)
                VALUES ('forest_joensuu', ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    mission_md = excluded.mission_md,
                    priorities_md = excluded.priorities_md,
                    constraints_md = excluded.constraints_md,
                    decision_principles_md = excluded.decision_principles_md,
                    updated_at = datetime('now')
                """,
                (
                    (name or "Forest Joensuu").strip()[:120],
                    (mission_md or "").strip()[:2_000],
                    (priorities_md or "").strip()[:2_000],
                    (constraints_md or "").strip()[:2_000],
                    (decision_principles_md or "").strip()[:2_000],
                ),
            )
            conn.commit()
            return self.get_organization_context()
        except Exception as exc:
            logger.error("Error saving Forest Joensuu context: %s", exc)
            return {}
        finally:
            if conn:
                conn.close()

    def list_partner_companies(self) -> List[Dict[str, Any]]:
        conn = None
        try:
            conn = self._get_connection()
            return [dict(row) for row in conn.execute(
                "SELECT * FROM partner_companies ORDER BY name COLLATE NOCASE ASC"
            ).fetchall()]
        except Exception as exc:
            logger.error("Error listing partner companies: %s", exc)
            return []
        finally:
            if conn:
                conn.close()

    def get_partner_company(self, company_id: str) -> Optional[Dict[str, Any]]:
        if not company_id:
            return None
        conn = None
        try:
            conn = self._get_connection()
            row = conn.execute("SELECT * FROM partner_companies WHERE id = ?", (company_id,)).fetchone()
            return dict(row) if row else None
        except Exception as exc:
            logger.error("Error loading partner company %s: %s", company_id, exc)
            return None
        finally:
            if conn:
                conn.close()

    def save_partner_company(
        self,
        name: str,
        context_md: str = "",
        priorities_md: str = "",
        constraints_md: str = "",
        company_id: str = "",
    ) -> Optional[Dict[str, Any]]:
        import uuid
        safe_name = (name or "").strip()[:120]
        if not safe_name:
            return None
        company_id = (company_id or "").strip() or f"company_{uuid.uuid4().hex[:10]}"
        conn = None
        try:
            conn = self._get_connection()
            existing = conn.execute("SELECT id FROM partner_companies WHERE id = ?", (company_id,)).fetchone()
            if existing:
                conn.execute(
                    """
                    UPDATE partner_companies
                    SET name = ?, context_md = ?, priorities_md = ?, constraints_md = ?, updated_at = datetime('now')
                    WHERE id = ?
                    """,
                    (
                        safe_name,
                        (context_md or "").strip()[:2_000],
                        (priorities_md or "").strip()[:2_000],
                        (constraints_md or "").strip()[:2_000],
                        company_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO partner_companies (id, name, context_md, priorities_md, constraints_md, updated_at)
                    VALUES (?, ?, ?, ?, ?, datetime('now'))
                    """,
                    (
                        company_id,
                        safe_name,
                        (context_md or "").strip()[:2_000],
                        (priorities_md or "").strip()[:2_000],
                        (constraints_md or "").strip()[:2_000],
                    ),
                )
            conn.commit()
            return self.get_partner_company(company_id)
        except Exception as exc:
            logger.error("Error saving partner company %s: %s", safe_name, exc)
            return None
        finally:
            if conn:
                conn.close()

    def delete_partner_company(self, company_id: str) -> bool:
        if not company_id:
            return False
        conn = None
        try:
            conn = self._get_connection()
            # Update associated notebooks to drop this company_id before deleting
            conn.execute("UPDATE notebooks SET company_id = '' WHERE company_id = ?", (company_id,))
            cursor = conn.execute("DELETE FROM partner_companies WHERE id = ?", (company_id,))
            conn.commit()
            return cursor.rowcount > 0
        except Exception as exc:
            logger.error("Error deleting partner company %s: %s", company_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def compile_business_context(self, notebook_ids: List[str]) -> str:
        """Compiles the small, saved business layer for a Manager task.

        This is operating context, not evidence. Documents are retrieved and
        cited separately, so user-authored context never becomes a source.
        """
        organization = self.get_organization_context()
        blocks: List[str] = []
        organization_fields = [
            ("Mission", organization.get("mission_md", "")),
            ("Portfolio priorities and measures", organization.get("priorities_md", "")),
            ("Organization-wide constraints", organization.get("constraints_md", "")),
            ("Decision principles", organization.get("decision_principles_md", "")),
        ]
        organization_lines = [
            f"[FOREST JOENSUU DNA — {organization.get('name') or 'Forest Joensuu'}]"
        ]
        organization_lines.extend(
            f"{label}: {str(value).strip()}" for label, value in organization_fields if str(value).strip()
        )
        if len(organization_lines) > 1:
            blocks.append("\n".join(organization_lines))

        seen_companies = set()
        selected_projects: List[Dict[str, Any]] = []
        for notebook_id in notebook_ids:
            project = self.get_notebook(str(notebook_id))
            if not project:
                continue
            selected_projects.append(project)
            company_id = str(project.get("company_id") or "")
            company_name = str(project.get("company_name") or "")
            if company_id and company_id not in seen_companies and company_name:
                seen_companies.add(company_id)
                company_lines = [f"[PARTNER COMPANY — {company_name}]"]
                for label, key in (
                    ("Business context", "company_context_md"),
                    ("Priorities and measures", "company_priorities_md"),
                    ("Constraints", "company_constraints_md"),
                ):
                    value = str(project.get(key) or "").strip()
                    if value:
                        company_lines.append(f"{label}: {value}")
                if len(company_lines) > 1:
                    blocks.append("\n".join(company_lines))

            project_lines = [f"[PROJECT BRIEF — {project.get('name') or notebook_id}]"]
            if str(project.get("description") or "").strip():
                project_lines.append(f"Purpose: {str(project['description']).strip()}")
            if str(project.get("project_brief_md") or "").strip():
                project_lines.append(f"Goal, priorities, targets and constraints: {str(project['project_brief_md']).strip()}")
            if str(project.get("knowledge_boundary_md") or "").strip():
                project_lines.append(f"Knowledge boundary: {str(project['knowledge_boundary_md']).strip()}")
            if len(project_lines) > 1:
                blocks.append("\n".join(project_lines))

        if len(selected_projects) > 1:
            blocks.append(
                "[MULTI-PROJECT RULE]\n"
                "Keep conclusions, evidence, targets and constraints labelled by company and project. "
                "Do not assume one project's information applies to another. Highlight shared opportunities, conflicts and trade-offs against Forest Joensuu priorities."
            )
        return "\n\n".join(blocks)[:12_000]

    def create_notebook(
        self,
        name: str,
        doc_names: List[str],
        description: str = "",
        knowledge_boundary_md: str = "",
        company_id: str = "",
        project_brief_md: str = "",
    ) -> str:
        import uuid
        notebook_id = f"nb_{uuid.uuid4().hex[:8]}"
        try:
            conn = self._get_connection()
            conn.execute(
                """
                INSERT INTO notebooks (id, name, company_id, description, project_brief_md, knowledge_boundary_md, project_status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))
                """,
                (
                    notebook_id,
                    name,
                    (company_id or "").strip()[:120],
                    description.strip()[:500],
                    project_brief_md.strip()[:2_000],
                    knowledge_boundary_md.strip()[:2_000],
                ),
            )
            for doc in doc_names:
                conn.execute("INSERT INTO notebook_documents (notebook_id, doc_name) VALUES (?, ?)", (notebook_id, doc))
            conn.commit()
            return notebook_id
        except Exception as e:
            logger.error(f"Error creating notebook {name}: {e}")
            return ""
        finally:
            if 'conn' in locals() and conn: conn.close()

    def get_notebook(self, notebook_id: str) -> Optional[Dict[str, Any]]:
        try:
            conn = self._get_connection()
            row = conn.execute(
                """
                SELECT n.*, c.name AS company_name, c.context_md AS company_context_md,
                    c.priorities_md AS company_priorities_md, c.constraints_md AS company_constraints_md
                FROM notebooks AS n
                LEFT JOIN partner_companies AS c ON c.id = n.company_id
                WHERE n.id = ?
                """,
                (notebook_id,),
            ).fetchone()
            if not row:
                return None
            nb = dict(row)
            docs = conn.execute("SELECT doc_name FROM notebook_documents WHERE notebook_id = ?", (notebook_id,)).fetchall()
            nb["doc_names"] = [d["doc_name"] for d in docs]
            return nb
        except Exception as e:
            logger.error(f"Error getting notebook {notebook_id}: {e}")
            return None
        finally:
            if 'conn' in locals() and conn: conn.close()

    def get_all_notebooks(self) -> List[Dict[str, Any]]:
        """Returns notebooks together with their owned source documents."""
        conn = None
        try:
            conn = self._get_connection()
            notebooks = []
            rows = conn.execute(
                """
                SELECT n.*, c.name AS company_name, c.context_md AS company_context_md,
                    c.priorities_md AS company_priorities_md, c.constraints_md AS company_constraints_md
                FROM notebooks AS n
                LEFT JOIN partner_companies AS c ON c.id = n.company_id
                ORDER BY n.created_at ASC, n.name ASC
                """
            ).fetchall()
            for row in rows:
                notebook = dict(row)
                docs = conn.execute(
                    "SELECT doc_name FROM notebook_documents WHERE notebook_id = ? ORDER BY doc_name ASC",
                    (notebook["id"],),
                ).fetchall()
                notebook["doc_names"] = [doc["doc_name"] for doc in docs]
                notebooks.append(notebook)
            return notebooks
        except Exception as e:
            logger.error(f"Error listing notebooks: {e}")
            return []
        finally:
            if conn:
                conn.close()

    def ensure_default_notebook(self) -> List[Dict[str, Any]]:
        """Creates a first project workspace and associates existing documents once."""
        notebooks = self.get_all_notebooks()
        if notebooks:
            return notebooks
        doc_names = [doc["file_name"] for doc in self.get_all_documents()]
        notebook_id = self.create_notebook(
            "Company Knowledge Base",
            doc_names,
            description="Shared ecosystem material for the initial AI Board Member pilot.",
            knowledge_boundary_md="Use only shared or public ecosystem knowledge. Human decision-makers retain final authority.",
        )
        return self.get_all_notebooks() if notebook_id else []

    def add_document_to_notebook(self, notebook_id: str, doc_name: str) -> bool:
        """Associates an already-ingested document with a notebook."""
        conn = None
        try:
            conn = self._get_connection()
            conn.execute(
                "INSERT OR IGNORE INTO notebook_documents (notebook_id, doc_name) VALUES (?, ?)",
                (notebook_id, doc_name),
            )
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Error adding document '{doc_name}' to notebook '{notebook_id}': {e}")
            return False
        finally:
            if conn:
                conn.close()

    def remove_document_from_notebook(self, notebook_id: str, doc_name: str) -> bool:
        """Removes a source from one project without deleting the shared document record."""
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute(
                "DELETE FROM notebook_documents WHERE notebook_id = ? AND doc_name = ?",
                (notebook_id, doc_name),
            )
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            logger.error(f"Error removing document '{doc_name}' from project '{notebook_id}': {e}")
            return False
        finally:
            if conn:
                conn.close()

    def resolve_notebook_source_scope(
        self, notebook_id: Optional[str], requested_doc_names: Optional[List[str]]
    ) -> List[str]:
        """Returns only documents that are members of the nominated project workspace.

        `None` preserves legacy whole-project behavior; an explicit empty list
        deliberately grants no RAG sources.
        """
        if not notebook_id:
            return []
        notebook = self.get_notebook(notebook_id)
        if not notebook:
            return []
        project_docs = notebook.get("doc_names", [])
        if requested_doc_names is None:
            return project_docs
        requested = {str(name) for name in requested_doc_names if str(name).strip()}
        return [doc_name for doc_name in project_docs if doc_name in requested]

    def update_notebook_project(
        self,
        notebook_id: str,
        name: Optional[str] = None,
        company_id: Optional[str] = None,
        description: Optional[str] = None,
        project_brief_md: Optional[str] = None,
        knowledge_boundary_md: Optional[str] = None,
        project_status: Optional[str] = None,
    ) -> bool:
        """Updates project metadata without affecting its knowledge tree."""
        updates: List[str] = []
        params: List[Any] = []
        if name is not None:
            updates.append("name = ?")
            params.append(name.strip()[:120])
        if company_id is not None:
            updates.append("company_id = ?")
            params.append(company_id.strip()[:120])
        if description is not None:
            updates.append("description = ?")
            params.append(description.strip()[:500])
        if project_brief_md is not None:
            updates.append("project_brief_md = ?")
            params.append(project_brief_md.strip()[:2_000])
        if knowledge_boundary_md is not None:
            updates.append("knowledge_boundary_md = ?")
            params.append(knowledge_boundary_md.strip()[:2000])
        if project_status is not None:
            updates.append("project_status = ?")
            params.append(project_status.strip()[:32])
        if not updates:
            return False
        updates.append("updated_at = datetime('now')")
        params.append(notebook_id)
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute(f"UPDATE notebooks SET {', '.join(updates)} WHERE id = ?", tuple(params))
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            logger.error(f"Error updating project '{notebook_id}': {e}")
            return False
        finally:
            if conn:
                conn.close()

    def delete_notebook(self, notebook_id: str) -> bool:
        """Deletes a notebook while preserving its source documents for other notebooks."""
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            logger.error(f"Error deleting notebook '{notebook_id}': {e}")
            return False
        finally:
            if conn:
                conn.close()

    def save_notebook_briefing(self, notebook_id: str, briefing_md: str) -> bool:
        try:
            conn = self._get_connection()
            conn.execute("UPDATE notebooks SET briefing_doc_md = ? WHERE id = ?", (briefing_md, notebook_id))
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Error saving notebook briefing {notebook_id}: {e}")
            return False
        finally:
            if 'conn' in locals() and conn: conn.close()

    # =========================================================================
    # DOCUMENT METADATA CRUD
    # =========================================================================
    def delete_document(self, file_name: str) -> bool:
        """Deletes a document and all its chunks/vectors from the database."""
        conn = None
        try:
            conn = self._get_connection()
            # Get chunk IDs to delete from vec_document_chunks
            chunk_rows = conn.execute("SELECT id FROM document_chunks WHERE doc_name = ?", (file_name,)).fetchall()
            chunk_ids = [r[0] for r in chunk_rows]
            
            # Delete from vec_document_chunks
            if HAS_SQLITE_VEC and chunk_ids:
                placeholders = ",".join(["?"] * len(chunk_ids))
                conn.execute(f"DELETE FROM vec_document_chunks WHERE chunk_id IN ({placeholders})", chunk_ids)
            
            # Delete from document_chunks
            conn.execute("DELETE FROM document_chunks WHERE doc_name = ?", (file_name,))
            # Delete from notebook_documents
            conn.execute("DELETE FROM notebook_documents WHERE doc_name = ?", (file_name,))
            # Delete from documents
            conn.execute("DELETE FROM documents WHERE file_name = ?", (file_name,))
            
            conn.commit()
            self._migrate_foreign_key_constraints(conn)
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Error deleting document '{file_name}': {e}")
            if conn:
                conn.rollback()
            return False
        finally:
            if conn:
                conn.close()

    @staticmethod
    def _has_foreign_key(conn: sqlite3.Connection, table: str, column: str, parent: str) -> bool:
        return any(
            row["from"] == column and row["table"] == parent
            for row in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()
        )

    def _migrate_foreign_key_constraints(self, conn: sqlite3.Connection) -> None:
        """Upgrade pre-existing databases that were created before FK constraints existed."""
        chunk_fk_ok = self._has_foreign_key(conn, "document_chunks", "doc_name", "documents")
        notebook_fk_ok = (
            self._has_foreign_key(conn, "notebook_documents", "notebook_id", "notebooks")
            and self._has_foreign_key(conn, "notebook_documents", "doc_name", "documents")
        )
        if chunk_fk_ok and notebook_fk_ok:
            return

        # SQLite cannot add foreign keys with ALTER TABLE. Rebuild child tables,
        # retaining valid rows and their IDs so vector references remain stable.
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            if not chunk_fk_ok:
                conn.execute("ALTER TABLE document_chunks RENAME TO document_chunks_legacy")
                conn.execute("""
                    CREATE TABLE document_chunks (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        doc_name TEXT NOT NULL REFERENCES documents(file_name) ON DELETE CASCADE,
                        chunk_index INTEGER NOT NULL DEFAULT 0,
                        text_content TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                """)
                conn.execute("""
                    INSERT INTO document_chunks (id, doc_name, chunk_index, text_content, created_at)
                    SELECT c.id, c.doc_name, c.chunk_index, c.text_content, c.created_at
                    FROM document_chunks_legacy AS c
                    JOIN documents AS d ON d.file_name = c.doc_name
                """)
                conn.execute("DROP TABLE document_chunks_legacy")

            if not notebook_fk_ok:
                conn.execute("ALTER TABLE notebook_documents RENAME TO notebook_documents_legacy")
                conn.execute("""
                    CREATE TABLE notebook_documents (
                        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
                        doc_name TEXT NOT NULL REFERENCES documents(file_name) ON DELETE CASCADE,
                        PRIMARY KEY (notebook_id, doc_name)
                    )
                """)
                conn.execute("""
                    INSERT INTO notebook_documents (notebook_id, doc_name)
                    SELECT nd.notebook_id, nd.doc_name
                    FROM notebook_documents_legacy AS nd
                    JOIN notebooks AS n ON n.id = nd.notebook_id
                    JOIN documents AS d ON d.file_name = nd.doc_name
                """)
                conn.execute("DROP TABLE notebook_documents_legacy")
        finally:
            conn.execute("PRAGMA foreign_keys = ON")

    # =========================================================================

    def save_document_metadata(
        self,
        file_name: str,
        extension: str = "",
        size_bytes: int = 0,
        text_length: int = 0,
        chunks_indexed: int = 0,
        storage_path: str = "",
        ai_summary: str = ""
    ) -> Dict[str, Any]:
        """Upserts document metadata into the local SQLite documents table."""
        try:
            conn = self._get_connection()
            conn.execute("""
                INSERT INTO documents (file_name, extension, size_bytes, text_length, chunks_indexed, storage_path, ai_summary)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(file_name) DO UPDATE SET
                    extension = excluded.extension,
                    size_bytes = excluded.size_bytes,
                    text_length = excluded.text_length,
                    chunks_indexed = excluded.chunks_indexed,
                    storage_path = excluded.storage_path,
                    ai_summary = excluded.ai_summary
            """, (file_name, extension, size_bytes, text_length, chunks_indexed, storage_path, ai_summary))
            conn.commit()
            conn.close()
            return {"status": "success", "storage_path": storage_path or file_name}
        except Exception as e:
            logger.error(f"Error saving document metadata '{file_name}': {e}")
            return {"status": "error", "message": str(e)}

    def get_all_documents(self) -> List[Dict[str, Any]]:
        """Fetches all document metadata from the local SQLite documents table."""
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute("SELECT * FROM documents ORDER BY created_at DESC").fetchall()
            return [dict(r) for r in rows]
        except Exception as e:
            logger.error(f"Error fetching documents: {e}")
            return []
        finally:
            if conn:
                conn.close()

    # =========================================================================
    # DOCUMENT CHUNKS & VECTOR EMBEDDINGS
    # =========================================================================

    def insert_chunk(self, doc_name: str, chunk_index: int, text_content: str, embedding: Optional[List[float]] = None) -> int:
        """Inserts a text chunk and its embedding vector into the local SQLite tables.
        Returns the chunk row id."""
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute(
                "INSERT INTO document_chunks (doc_name, chunk_index, text_content) VALUES (?, ?, ?)",
                (doc_name, chunk_index, text_content)
            )
            chunk_id = cur.lastrowid

            if embedding and HAS_SQLITE_VEC:
                blob = _serialize_float32(embedding)
                conn.execute(
                    "INSERT INTO vec_document_chunks (chunk_id, embedding) VALUES (?, ?)",
                    (chunk_id, blob)
                )

            conn.commit()
            return chunk_id
        except Exception as e:
            logger.error(f"Error inserting chunk for '{doc_name}' idx {chunk_index}: {e}")
            return -1
        finally:
            if conn:
                conn.close()

    def search_vectors(
        self,
        query_embedding: List[float],
        top_k: int = 3,
        notebook_id: Optional[str] = None,
        document_names: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Executes K-Nearest Neighbor vector similarity search using sqlite-vec.
        Returns matching text chunks ranked by distance (lower = more similar)."""
        if not HAS_SQLITE_VEC:
            logger.warning("sqlite-vec not available, vector search disabled.")
            return []

        conn = None
        try:
            conn = self._get_connection()
            blob = _serialize_float32(query_embedding)
            
            query = """
                SELECT c.text_content, c.doc_name, c.chunk_index, v.distance
                FROM vec_document_chunks v
                JOIN document_chunks c ON v.chunk_id = c.id
            """
            params: List[Any] = [blob]
            conditions = ["v.embedding MATCH ?"]
            if notebook_id:
                query += " JOIN notebook_documents nd ON c.doc_name = nd.doc_name"
                conditions.append("nd.notebook_id = ?")
                params.append(notebook_id)
            if document_names is not None:
                scoped_names = [str(name) for name in document_names if str(name).strip()]
                if not scoped_names:
                    return []
                conditions.append("c.doc_name IN (" + ", ".join("?" for _ in scoped_names) + ")")
                params.extend(scoped_names)
            query += " WHERE " + " AND ".join(conditions)
            query += " ORDER BY v.distance LIMIT ?"
            params.append(max(1, min(int(top_k), 10)))
            
            rows = conn.execute(query, tuple(params)).fetchall()
            return [dict(r) for r in rows]
        except Exception as e:
            logger.error(f"Error executing vector search: {e}")
            return []
        finally:
            if conn:
                conn.close()

    def get_db_stats(self) -> Dict[str, Any]:
        """Returns live statistics about the embedded SQLite database."""
        stats = {
            "db_path": self.db_path,
            "is_initialized": self.is_initialized,
            "sqlite_vec_available": HAS_SQLITE_VEC,
            "agent_profiles_count": 0,
            "user_profiles_count": 0,
            "documents_count": 0,
            "document_chunks_count": 0,
            "vec_chunks_count": 0,
            "db_size_bytes": 0
        }
        conn = None
        try:
            if os.path.exists(self.db_path):
                stats["db_size_bytes"] = os.path.getsize(self.db_path)

            conn = self._get_connection()
            stats["agent_profiles_count"] = conn.execute("SELECT COUNT(*) FROM agent_profiles").fetchone()[0]
            stats["user_profiles_count"] = conn.execute("SELECT COUNT(*) FROM user_profiles").fetchone()[0]
            stats["documents_count"] = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            stats["document_chunks_count"] = conn.execute("SELECT COUNT(*) FROM document_chunks").fetchone()[0]
            if HAS_SQLITE_VEC:
                stats["vec_chunks_count"] = conn.execute("SELECT COUNT(*) FROM vec_document_chunks").fetchone()[0]
        except Exception as e:
            logger.error(f"Error fetching DB stats: {e}")
        finally:
            if conn:
                conn.close()
        return stats



    # Generic Dashboard Methods (Supabase-like)
    @staticmethod
    def _quote_identifier(identifier: str) -> str:
        """Quote an identifier after validating it against SQLite metadata."""
        return '"' + identifier.replace('"', '""') + '"'

    def _get_table_columns(self, conn: sqlite3.Connection, table_name: str) -> List[str]:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? AND name NOT LIKE 'sqlite_%'",
            (table_name,),
        ).fetchone()
        if not table:
            raise ValueError("Unknown table")
        quoted_table = self._quote_identifier(table_name)
        return [row["name"] for row in conn.execute(f"PRAGMA table_info({quoted_table})").fetchall()]

    def get_all_tables(self) -> List[str]:
        try:
            conn = self._get_connection()
            cur = conn.cursor()
            cur.execute("""
                SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name NOT LIKE 'sqlite_%'
                  AND name NOT LIKE 'vec_document_chunks%'
                ORDER BY name
            """)
            tables = [row["name"] for row in cur.fetchall()]
            conn.close()
            return tables
        except Exception as e:
            logger.error(f"Error getting tables: {e}")
            return []

    def get_table_schema(self, table_name: str) -> List[Dict[str, Any]]:
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.cursor()
            self._get_table_columns(conn, table_name)
            cur.execute(f"PRAGMA table_info({self._quote_identifier(table_name)})")
            columns = [dict(row) for row in cur.fetchall()]
            return columns
        except Exception as e:
            logger.error(f"Error getting schema for {table_name}: {e}")
            return []
        finally:
            if conn:
                conn.close()

    def search_document_chunks_lexically(
        self,
        query: str,
        top_k: int = 3,
        notebook_id: Optional[str] = None,
        document_names: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Persistent keyword fallback when vector search is unavailable."""
        terms = [term.lower() for term in query.split() if len(term) >= 3][:6]
        if not terms:
            return []
        conn = None
        try:
            conn = self._get_connection()
            predicates = " OR ".join("LOWER(c.text_content) LIKE ?" for _ in terms)
            params: List[Any] = []
            query_sql = "SELECT c.doc_name, c.text_content, c.chunk_index FROM document_chunks c"
            conditions: List[str] = []
            if notebook_id:
                query_sql += " JOIN notebook_documents nd ON nd.doc_name = c.doc_name"
                conditions.append("nd.notebook_id = ?")
                params.append(notebook_id)
            if document_names is not None:
                scoped_names = [str(name) for name in document_names if str(name).strip()]
                if not scoped_names:
                    return []
                conditions.append("c.doc_name IN (" + ", ".join("?" for _ in scoped_names) + ")")
                params.extend(scoped_names)
            conditions.append("(" + predicates + ")")
            params.extend(f"%{term}%" for term in terms)
            query_sql += " WHERE " + " AND ".join(conditions) + " ORDER BY c.doc_name, c.chunk_index LIMIT ?"
            params.append(max(1, min(int(top_k), 10)))
            return [dict(row) for row in conn.execute(query_sql, tuple(params)).fetchall()]
        except Exception as e:
            logger.error(f"Lexical document search failed: {e}")
            return []
        finally:
            if conn:
                conn.close()

    def get_table_rows(self, table_name: str, limit: int = 100) -> List[Dict[str, Any]]:
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.cursor()
            self._get_table_columns(conn, table_name)
            safe_limit = max(1, min(int(limit), 500))
            cur.execute(f"SELECT * FROM {self._quote_identifier(table_name)} LIMIT ?", (safe_limit,))
            rows = [dict(row) for row in cur.fetchall()]
            return rows
        except Exception as e:
            logger.error(f"Error getting rows for {table_name}: {e}")
            return []
        finally:
            if conn:
                conn.close()

    def delete_table_row(self, table_name: str, pk_col: str, pk_val: Any) -> bool:
        conn = None
        try:
            conn = self._get_connection()
            columns = self._get_table_columns(conn, table_name)
            if pk_col not in columns:
                raise ValueError("Unknown column")
            cur = conn.cursor()
            cur.execute(f"DELETE FROM {self._quote_identifier(table_name)} WHERE {self._quote_identifier(pk_col)} = ?", (pk_val,))
            conn.commit()
            success = cur.rowcount > 0
            return success
        except Exception as e:
            logger.error(f"Error deleting row from {table_name}: {e}")
            return False
        finally:
            if conn:
                conn.close()

    def update_table_row(self, table_name: str, pk_col: str, pk_val: Any, data: Dict[str, Any]) -> bool:
        if not data:
            return True
        conn = None
        try:
            conn = self._get_connection()
            columns = self._get_table_columns(conn, table_name)
            if pk_col not in columns:
                raise ValueError("Unknown column")
            cur = conn.cursor()
            set_clauses = []
            values = []
            for k, v in data.items():
                if k == pk_col or k not in columns:
                    continue
                set_clauses.append(f"{self._quote_identifier(k)} = ?")
                values.append(v)
            
            if not set_clauses: return True
            
            query = f"UPDATE {self._quote_identifier(table_name)} SET {', '.join(set_clauses)} WHERE {self._quote_identifier(pk_col)} = ?"
            values.append(pk_val)
            
            cur.execute(query, tuple(values))
            conn.commit()
            success = cur.rowcount > 0
            return success
        except Exception as e:
            logger.error(f"Error updating row in {table_name}: {e}")
            return False
        finally:
            if conn:
                conn.close()

    def insert_table_row(self, table_name: str, data: Dict[str, Any]) -> bool:
        """Inserts a row through the developer dashboard after validating all columns."""
        if not data:
            return False
        conn = None
        try:
            conn = self._get_connection()
            columns = self._get_table_columns(conn, table_name)
            safe_data = {key: value for key, value in data.items() if key in columns and value != ""}
            if not safe_data:
                return False
            column_sql = ", ".join(self._quote_identifier(column) for column in safe_data)
            values_sql = ", ".join("?" for _ in safe_data)
            conn.execute(
                f"INSERT INTO {self._quote_identifier(table_name)} ({column_sql}) VALUES ({values_sql})",
                tuple(safe_data.values()),
            )
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Error inserting row in {table_name}: {e}")
            return False
        finally:
            if conn:
                conn.close()

    # --- Autonomous Research Task Methods ---
    def create_autonomous_task(
        self,
        task_id: str,
        query: str,
        username: str,
        notebook_ids: List[str],
        source_doc_names: Optional[List[str]] = None,
        max_web_sources: int = 3,
        task_type: str = "deep_research",
        context: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Creates a bounded, auditable read-only research task."""
        conn = None
        try:
            conn = self._get_connection()
            conn.execute(
                """
                INSERT INTO autonomous_tasks
                    (id, task_type, query, username, notebook_ids_json, source_doc_names_json, max_web_sources, context_json, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')
                """,
                (
                    task_id,
                    task_type[:80],
                    query,
                    username,
                    json.dumps(notebook_ids),
                    json.dumps(source_doc_names or []),
                    max(1, min(int(max_web_sources), 5)),
                    json.dumps(context or {}),
                ),
            )
            conn.commit()
            return True
        except Exception as exc:
            logger.error("Error creating autonomous task %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def update_autonomous_task(
        self,
        task_id: str,
        *,
        status: Optional[str] = None,
        plan: Optional[List[Dict[str, Any]]] = None,
        result_md: Optional[str] = None,
        error_message: Optional[str] = None,
        last_action: Optional[str] = None,
    ) -> bool:
        """Updates only named task fields; task state stays inspectable after a restart."""
        values: List[Any] = []
        clauses: List[str] = []
        if status is not None:
            clauses.append("status = ?")
            values.append(status)
            if status == "running":
                clauses.append("started_at = COALESCE(started_at, datetime('now'))")
            if status in {"completed", "failed", "cancelled"}:
                clauses.append("completed_at = datetime('now')")
        if plan is not None:
            clauses.append("plan_json = ?")
            values.append(json.dumps(plan))
        if result_md is not None:
            clauses.append("result_md = ?")
            values.append(result_md)
        if error_message is not None:
            clauses.append("error_message = ?")
            values.append(error_message)
        if last_action is not None:
            clauses.append("last_action = ?")
            values.append(last_action[:500])
        if not clauses:
            return True

        conn = None
        try:
            conn = self._get_connection()
            values.append(task_id)
            result = conn.execute(
                f"UPDATE autonomous_tasks SET {', '.join(clauses)} WHERE id = ?",
                tuple(values),
            )
            conn.commit()
            return result.rowcount > 0
        except Exception as exc:
            logger.error("Error updating autonomous task %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def request_autonomous_task_cancel(self, task_id: str, reason: str = "") -> bool:
        """Request cooperative cancellation; a running network call is not force-killed."""
        conn = None
        try:
            conn = self._get_connection()
            result = conn.execute(
                """
                UPDATE autonomous_tasks
                SET cancel_requested = 1, cancel_reason = ?, last_action = ?
                WHERE id = ? AND status IN ('queued', 'running')
                """,
                (reason[:1_000], "Stop requested — completing the current safe boundary.", task_id),
            )
            if result.rowcount:
                conn.execute(
                    "INSERT INTO autonomous_task_controls (task_id, control_type, content_md, status) VALUES (?, 'stop', ?, 'accepted')",
                    (task_id, reason[:1_000]),
                )
            conn.commit()
            return result.rowcount > 0
        except Exception as exc:
            logger.error("Error requesting cancellation for autonomous task %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def is_autonomous_task_cancel_requested(self, task_id: str) -> bool:
        conn = None
        try:
            conn = self._get_connection()
            row = conn.execute("SELECT cancel_requested FROM autonomous_tasks WHERE id = ?", (task_id,)).fetchone()
            return bool(row and row["cancel_requested"])
        except Exception as exc:
            logger.error("Error checking cancellation for autonomous task %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def add_autonomous_task_steering(self, task_id: str, direction: str) -> bool:
        """Queue a bounded user direction for the next safe workflow boundary."""
        clean_direction = direction.strip()
        if not clean_direction or len(clean_direction) > 2_000:
            return False
        conn = None
        try:
            conn = self._get_connection()
            task = conn.execute("SELECT status FROM autonomous_tasks WHERE id = ?", (task_id,)).fetchone()
            if not task or task["status"] not in {"queued", "running"}:
                return False
            conn.execute(
                "INSERT INTO autonomous_task_controls (task_id, control_type, content_md) VALUES (?, 'steer', ?)",
                (task_id, clean_direction),
            )
            conn.execute(
                "UPDATE autonomous_tasks SET last_action = ? WHERE id = ?",
                ("New direction received — it will apply at the next safe step.", task_id),
            )
            conn.commit()
            return True
        except Exception as exc:
            logger.error("Error adding steering for autonomous task %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def get_autonomous_task_steering(self, task_id: str) -> List[str]:
        conn = None
        try:
            conn = self._get_connection()
            return [
                str(row["content_md"])
                for row in conn.execute(
                    "SELECT content_md FROM autonomous_task_controls WHERE task_id = ? AND control_type = 'steer' ORDER BY id",
                    (task_id,),
                ).fetchall()
            ]
        except Exception as exc:
            logger.error("Error reading steering for autonomous task %s: %s", task_id, exc)
            return []
        finally:
            if conn:
                conn.close()

    def add_autonomous_task_step(
        self,
        task_id: str,
        step_index: int,
        tool_name: str,
        input_summary: str = "",
        status: str = "queued",
    ) -> int:
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute(
                """
                INSERT INTO autonomous_task_steps
                    (task_id, step_index, tool_name, status, input_summary)
                VALUES (?, ?, ?, ?, ?)
                """,
                (task_id, step_index, tool_name, status, input_summary[:2_000]),
            )
            conn.commit()
            return int(cur.lastrowid)
        except Exception as exc:
            logger.error("Error adding autonomous task step for %s: %s", task_id, exc)
            return -1
        finally:
            if conn:
                conn.close()

    def complete_autonomous_task_step(self, step_id: int, status: str, output_summary: str = "") -> bool:
        if step_id < 0:
            return False
        conn = None
        try:
            conn = self._get_connection()
            result = conn.execute(
                """
                UPDATE autonomous_task_steps
                SET status = ?, output_summary = ?, completed_at = datetime('now')
                WHERE id = ?
                """,
                (status, output_summary[:6_000], step_id),
            )
            conn.commit()
            return result.rowcount > 0
        except Exception as exc:
            logger.error("Error completing autonomous step %s: %s", step_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def save_research_artifact(
        self,
        task_id: str,
        title: str,
        content_md: str,
        sources: List[Dict[str, Any]],
        artifact_type: str = "research_report",
    ) -> bool:
        conn = None
        try:
            conn = self._get_connection()
            conn.execute(
                """
                INSERT INTO research_artifacts (task_id, artifact_type, title, content_md, sources_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (task_id, artifact_type, title[:300], content_md, json.dumps(sources)),
            )
            conn.commit()
            return True
        except Exception as exc:
            logger.error("Error saving research artifact for %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def request_autonomous_approval(self, task_id: str, action_name: str, summary: str) -> int:
        """Records a proposed privileged action. It does not execute the action."""
        conn = None
        try:
            conn = self._get_connection()
            cur = conn.execute(
                """
                INSERT INTO autonomous_approvals (task_id, action_name, requested_summary)
                VALUES (?, ?, ?)
                """,
                (task_id, action_name[:120], summary[:2_000]),
            )
            conn.commit()
            return int(cur.lastrowid)
        except Exception as exc:
            logger.error("Error creating approval for %s: %s", task_id, exc)
            return -1
        finally:
            if conn:
                conn.close()

    def decide_autonomous_approval(self, approval_id: int, status: str, decided_by: str) -> bool:
        if status not in {"approved", "rejected"}:
            return False
        conn = None
        try:
            conn = self._get_connection()
            result = conn.execute(
                """
                UPDATE autonomous_approvals
                SET status = ?, decided_by = ?, decided_at = datetime('now')
                WHERE id = ? AND status = 'pending'
                """,
                (status, decided_by[:120], approval_id),
            )
            conn.commit()
            return result.rowcount > 0
        except Exception as exc:
            logger.error("Error deciding approval %s: %s", approval_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def get_autonomous_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        conn = None
        try:
            conn = self._get_connection()
            task_row = conn.execute("SELECT * FROM autonomous_tasks WHERE id = ?", (task_id,)).fetchone()
            if not task_row:
                return None
            task = dict(task_row)
            for key in ("notebook_ids_json", "source_doc_names_json", "plan_json", "context_json"):
                try:
                    task[key.removesuffix("_json")] = json.loads(task.pop(key) or "[]")
                except json.JSONDecodeError:
                    task[key.removesuffix("_json")] = []
            task["steps"] = [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM autonomous_task_steps WHERE task_id = ? ORDER BY step_index, id",
                    (task_id,),
                ).fetchall()
            ]
            task["artifacts"] = []
            for row in conn.execute(
                "SELECT * FROM research_artifacts WHERE task_id = ? ORDER BY id",
                (task_id,),
            ).fetchall():
                artifact = dict(row)
                try:
                    artifact["sources"] = json.loads(artifact.pop("sources_json") or "[]")
                except json.JSONDecodeError:
                    artifact["sources"] = []
                task["artifacts"].append(artifact)
            task["approvals"] = [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM autonomous_approvals WHERE task_id = ? ORDER BY id",
                    (task_id,),
                ).fetchall()
            ]
            task["controls"] = [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM autonomous_task_controls WHERE task_id = ? ORDER BY id",
                    (task_id,),
                ).fetchall()
            ]
            return task
        except Exception as exc:
            logger.error("Error fetching autonomous task %s: %s", task_id, exc)
            return None
        finally:
            if conn:
                conn.close()

    def list_autonomous_tasks(self, username: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        """Return compact, newest-first agent activity records for the audit-log view."""
        conn = None
        try:
            conn = self._get_connection()
            safe_limit = max(1, min(int(limit), 200))
            where_clause = "WHERE t.username = ?" if username else ""
            params: List[Any] = [username] if username else []
            params.append(safe_limit)
            rows = conn.execute(
                f"""
                SELECT t.id, t.task_type, t.query, t.username, t.status, t.last_action,
                       t.result_md, t.error_message, t.created_at, t.started_at, t.completed_at,
                       COUNT(s.id) AS step_count
                FROM autonomous_tasks t
                LEFT JOIN autonomous_task_steps s ON s.task_id = t.id
                {where_clause}
                GROUP BY t.id
                ORDER BY COALESCE(t.completed_at, t.started_at, t.created_at) DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
            return [dict(row) for row in rows]
        except Exception as exc:
            logger.error("Error listing autonomous tasks: %s", exc)
            return []
        finally:
            if conn:
                conn.close()

    # --- Kanban Tasks Methods ---
    def add_kanban_task(
        self,
        task_id: str,
        prompt: str,
        scheduled_time: str,
        scheduled_timezone: str = "UTC",
        *,
        username: str = "alex",
        notebook_ids: Optional[List[str]] = None,
        schedule_enabled: bool = False,
        chat_session_id: str = "",
        root_task_id: Optional[str] = None,
        parent_task_id: str = "",
        version: int = 1,
    ) -> bool:
        conn = None
        try:
            conn = self._get_connection()
            conn.execute(
                """
                INSERT INTO kanban_tasks
                    (id, prompt, scheduled_time, scheduled_timezone, root_task_id, parent_task_id, version, username, notebook_ids_json, schedule_enabled, chat_session_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    prompt,
                    scheduled_time,
                    scheduled_timezone[:100] or "UTC",
                    root_task_id or task_id,
                    parent_task_id,
                    max(1, int(version)),
                    (username or "alex")[:100],
                    json.dumps(notebook_ids or []),
                    int(bool(schedule_enabled)),
                    (chat_session_id or "")[:100],
                ),
            )
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Error adding kanban task: {e}")
            return False
        finally:
            if conn: conn.close()

    def update_kanban_task_status(
        self,
        task_id: str,
        status: str,
        summary: str = "",
        result_md: str = "",
        error_message: str = "",
    ) -> bool:
        if status not in {"pending", "running", "done", "failed"}:
            return False
        conn = None
        try:
            conn = self._get_connection()
            clauses = ["status = ?", "result_summary = ?"]
            values: List[Any] = [status, summary[:1_000]]
            if status == "pending":
                clauses.extend(["started_at = NULL", "completed_at = NULL", "error_message = ''"])
            if status == "running":
                clauses.append("started_at = COALESCE(started_at, datetime('now'))")
            if status in {"done", "failed"}:
                clauses.extend(["result_md = ?", "error_message = ?", "completed_at = datetime('now')"])
                values.extend([result_md, error_message[:2_000]])
            values.append(task_id)
            result = conn.execute(
                f"UPDATE kanban_tasks SET {', '.join(clauses)} WHERE id = ?",
                tuple(values),
            )
            conn.commit()
            return result.rowcount > 0
        except Exception as e:
            logger.error(f"Error updating kanban task: {e}")
            return False
        finally:
            if conn: conn.close()

    def get_all_kanban_tasks(self) -> List[Dict[str, Any]]:
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute(
                "SELECT * FROM kanban_tasks ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, scheduled_time ASC, created_at DESC"
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception as e:
            logger.error(f"Error fetching kanban tasks: {e}")
            return []
        finally:
            if conn: conn.close()

    def update_pending_kanban_task(
        self,
        task_id: str,
        *,
        prompt: str,
        scheduled_time: str,
        scheduled_timezone: str,
        schedule_enabled: bool,
        notebook_ids: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Edits only queued work; an already-running agent must not be rewritten."""
        conn = None
        try:
            conn = self._get_connection()
            result = conn.execute(
                """
                UPDATE kanban_tasks
                SET prompt = ?, scheduled_time = ?, scheduled_timezone = ?,
                    schedule_enabled = ?, notebook_ids_json = ?
                WHERE id = ? AND status = 'pending'
                """,
                (
                    prompt,
                    scheduled_time,
                    scheduled_timezone[:100] or "UTC",
                    int(bool(schedule_enabled)),
                    json.dumps(notebook_ids or []),
                    task_id,
                ),
            )
            conn.commit()
            if result.rowcount <= 0:
                return None
            row = conn.execute("SELECT * FROM kanban_tasks WHERE id = ?", (task_id,)).fetchone()
            return dict(row) if row else None
        except Exception as exc:
            logger.error("Error updating Kanban task %s: %s", task_id, exc)
            return None
        finally:
            if conn:
                conn.close()

    def get_kanban_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        conn = None
        try:
            conn = self._get_connection()
            row = conn.execute("SELECT * FROM kanban_tasks WHERE id = ?", (task_id,)).fetchone()
            return dict(row) if row else None
        except Exception as exc:
            logger.error("Error fetching Kanban task %s: %s", task_id, exc)
            return None
        finally:
            if conn:
                conn.close()

    def get_kanban_task_versions(self, task_id: str) -> List[Dict[str, Any]]:
        task = self.get_kanban_task(task_id)
        if not task:
            return []
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute(
                "SELECT * FROM kanban_tasks WHERE root_task_id = ? ORDER BY version ASC, created_at ASC",
                (task["root_task_id"] or task["id"],),
            ).fetchall()
            return [dict(row) for row in rows]
        except Exception as exc:
            logger.error("Error fetching Kanban task versions for %s: %s", task_id, exc)
            return []
        finally:
            if conn:
                conn.close()

    def delete_kanban_task(self, task_id: str) -> bool:
        conn = None
        try:
            conn = self._get_connection()
            result = conn.execute("DELETE FROM kanban_tasks WHERE id = ? AND status != 'running'", (task_id,))
            conn.commit()
            return result.rowcount > 0
        except Exception as exc:
            logger.error("Error deleting Kanban task %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def start_kanban_task(self, task_id: str) -> bool:
        """Atomically claim a pending task so only one user or scheduler executes it."""
        conn = None
        try:
            conn = self._get_connection()
            result = conn.execute(
                """
                UPDATE kanban_tasks
                SET status = 'running', started_at = datetime('now'), completed_at = NULL,
                    result_summary = '', result_md = '', error_message = ''
                WHERE id = ? AND status = 'pending'
                """,
                (task_id,),
            )
            conn.commit()
            return result.rowcount > 0
        except Exception as exc:
            logger.error("Error starting Kanban task %s: %s", task_id, exc)
            return False
        finally:
            if conn:
                conn.close()

    def list_due_scheduled_kanban_tasks(self, now_utc_iso: str) -> List[str]:
        """Returns IDs due for execution; start_kanban_task remains the atomic claim."""
        conn = None
        try:
            conn = self._get_connection()
            rows = conn.execute(
                """
                SELECT id FROM kanban_tasks
                WHERE status = 'pending' AND schedule_enabled = 1 AND scheduled_time <= ?
                ORDER BY scheduled_time ASC
                """,
                (now_utc_iso,),
            ).fetchall()
            return [str(row["id"]) for row in rows]
        except Exception as exc:
            logger.error("Error listing due scheduled Kanban tasks: %s", exc)
            return []
        finally:
            if conn:
                conn.close()

    def create_kanban_rerun(self, task_id: str, new_task_id: str, scheduled_time: str, scheduled_timezone: str) -> Optional[Dict[str, Any]]:
        original = self.get_kanban_task(task_id)
        if not original or original.get("status") not in {"done", "failed"}:
            return None
        root_id = original.get("root_task_id") or original["id"]
        conn = None
        try:
            conn = self._get_connection()
            row = conn.execute(
                "SELECT COALESCE(MAX(version), 0) AS latest_version FROM kanban_tasks WHERE root_task_id = ?",
                (root_id,),
            ).fetchone()
            version = int(row["latest_version"] or 0) + 1
            conn.execute(
                """
                INSERT INTO kanban_tasks
                    (id, prompt, scheduled_time, scheduled_timezone, root_task_id, parent_task_id, version, status, username, notebook_ids_json, schedule_enabled, chat_session_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, '')
                """,
                (
                    new_task_id,
                    original["prompt"],
                    scheduled_time,
                    scheduled_timezone[:100] or "UTC",
                    root_id,
                    original["id"],
                    version,
                    original.get("username") or "alex",
                    original.get("notebook_ids_json") or "[]",
                ),
            )
            conn.commit()
            return self.get_kanban_task(new_task_id)
        except Exception as exc:
            logger.error("Error creating Kanban rerun for %s: %s", task_id, exc)
            return None
        finally:
            if conn:
                conn.close()

# Singleton instance
db_manager = LocalDBManager()

