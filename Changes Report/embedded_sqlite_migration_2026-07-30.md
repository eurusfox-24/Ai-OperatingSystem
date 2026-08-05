# Embedded SQLite Migration - Changes Report
**Date**: 2026-07-30

## Summary of Architectural Changes
Complete migration from Cloud/Local Supabase (PostgreSQL + pgvector) to a zero-config, self-contained embedded SQLite architecture using `sqlite-vec` for vector similarity search. The entire system now runs from a single local database file (`data/kernel_workspace.db`) with no external service dependencies.

## Detailed Technical Changes

### 1. New Files Created

#### `kernel/db/__init__.py`
- Package init for the new `kernel.db` module.

#### `kernel/db/local_manager.py` — LocalDBManager
- **Core embedded SQLite controller** managing all persistent data.
- Loads `sqlite-vec` extension on every connection for vec0 virtual table support.
- Database file: `data/kernel_workspace.db`
- **Schema Tables**:
  - `agent_profiles` (agent_id PK, agent_name, role_label, soul_md, rules_md, provider, model, temperature, max_tokens, updated_at)
  - `user_profiles` (user_id PK, display_name, role, profile_md, tone_style, custom_instructions, updated_at)
  - `documents` (file_name PK, extension, size_bytes, text_length, chunks_indexed, storage_path, ai_summary, created_at)
  - `document_chunks` (id AUTOINCREMENT, doc_name, chunk_index, text_content, created_at)
  - `vec_document_chunks` (vec0 virtual table: chunk_id PK, embedding float[1536])
- **Key Methods**: `save_agent_profile()`, `get_all_agent_profiles()`, `save_user_profile()`, `insert_chunk()` (with `struct.pack` vector serialization), `search_vectors()` (KNN MATCH query), `get_db_stats()`

### 2. Modified Files

#### `kernel/core/framework.py` — BaseAgent
- Added `from kernel.db.local_manager import db_manager` import.
- Added `_load_profile_from_db()` method that loads persisted agent profile (soul_md, provider, model, temperature) from SQLite on init.
- Added `compile_system_prompt(user_id)` method that dynamically layers Soul MD + Rules MD + User Preferences into a clean Markdown prompt.
- `update_system_prompt()` now auto-persists to SQLite via `db_manager.save_agent_profile()`.
- `update_model_config()` now auto-persists updated provider/model/temperature to SQLite.

#### `kernel/rag/doc_store.py` — DocumentIngestionEngine
- Replaced `supabase_manager` import with `db_manager`.
- `ingest_document()` now stores raw files in `data/documents/`, inserts chunks via `db_manager.insert_chunk()` (with vector embeddings), and persists metadata via `db_manager.save_document_metadata()`.
- `list_ingested_documents()` now reads from SQLite `documents` table.
- `search_relevant_docs()` now uses `db_manager.search_vectors()` for KNN search with fallback to in-memory cosine.

#### `kernel/core/users.py` — UserManager
- Replaced `supabase_manager` import with `db_manager`.
- `authenticate()` syncs user session to SQLite `user_profiles` table.
- `update_customization()` persists profile changes to SQLite `user_profiles` table.

#### `kernel/server.py` — FastAPI Server
- Replaced `supabase_manager` import with `db_manager`.
- `GET /api/agents/prompts` reads from `db_manager.get_all_agent_profiles()` (using `soul_md` column).
- `POST /api/agents/prompt/update` persistence now handled by `BaseAgent.update_system_prompt()` which auto-writes to SQLite.
- Document endpoints updated to reference local SQLite in docstrings.
- **New endpoint**: `GET /api/db/stats` returns live SQLite database statistics.

#### `kernel/core/config.py` — Settings
- Removed `SupabaseSettings` class and `supabase` field.
- Added `LocalDBSettings` class with `db_path` setting (default: `data/kernel_workspace.db`).

#### `ui/index.html` — Frontend HTML
- Updated all Supabase references to "Embedded SQLite" / "sqlite-vec":
  - Agent Customization Studio header/badges
  - Document Ingestion Hub header/badges
  - Database Telemetry Dashboard (tables, vector engine, file storage references)
  - Agent selector option labels

#### `ui/src/main.ts` — Frontend TypeScript
- Bulk-replaced all "Supabase" string literals with "Local SQLite" / "Local Embedded SQLite".
- Fixed function names broken by bulk replace (`fetchDocumentsFromDB`, `dashDbStatus`).
- Updated prompt inspector compiled output to reference `agent_profiles` table.

### 3. Deleted Files

#### `kernel/core/supabase_client.py`
- Entire file removed (was the LocalSupabaseManager connecting to PostgreSQL/pgvector).

### 4. Dependencies

#### Added
- `sqlite-vec` (v0.1.9) — SQLite extension for vec0 virtual tables and KNN vector search.

#### No Longer Required (can be uninstalled)
- `supabase` (supabase-py) — No longer used anywhere in the codebase.

## Verification Results
- ✅ All Python imports clean (kernel.server, kernel.db.local_manager, kernel.core.framework, kernel.rag.doc_store, kernel.core.users)
- ✅ SQLite database initialized at `data/kernel_workspace.db` (61,440 bytes)
- ✅ sqlite-vec extension loaded and vec0 virtual table created
- ✅ Vite frontend build clean (6 modules, 0 errors)
- ✅ All 20 API routes registered including new `/api/db/stats`
- ✅ Zero remaining references to `supabase` in kernel Python code
- ✅ Zero remaining references to `Supabase` in frontend TypeScript
