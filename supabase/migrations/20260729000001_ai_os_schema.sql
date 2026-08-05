-- Forest Joensuu AI OS: Supabase Local Schema Bootstrap
-- Enables pgvector extension and creates all required tables

-- 1. Enable pgvector extension for 1536-dim Azure OpenAI embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Agent System Prompts Table (edited in Habitat Studio)
CREATE TABLE IF NOT EXISTS agent_prompts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_type TEXT UNIQUE NOT NULL,
    agent_name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Document Knowledge Base Table (for RAG ingestion metadata)
CREATE TABLE IF NOT EXISTS documents (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    file_name TEXT UNIQUE NOT NULL,
    extension TEXT,
    size_bytes INTEGER,
    text_length INTEGER,
    chunks_indexed INTEGER DEFAULT 0,
    ai_summary TEXT,
    extracted_text TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Document Vector Chunks Table (1536-dim pgvector embeddings)
CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    file_name TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create pgvector HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
    ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- 6. Chat History per user
CREATE TABLE IF NOT EXISTS chat_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
