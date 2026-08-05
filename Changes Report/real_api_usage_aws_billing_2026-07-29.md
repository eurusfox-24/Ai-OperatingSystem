# Technical Changes Report: Real API Usage Counter & AWS Cloud Billing Integration

**Date**: 2026-07-29  
**Author**: Antigravity AI Assistant  
**Project**: Forest Joensuu & Business Joensuu AI Board Member OS

---

## 1. Summary of Architectural Changes

We replaced static mock data with a **Real-Time API Telemetry & AWS-Style Cloud Billing System** connected directly to the live Azure OpenAI API (`mvp-gpt-54-mini`, `mvp-embed-small`, `mvp-gpt-54`):

1. **Zeroed Counter Startup**:
   - The API Usage counter starts at **$0.00 / 0 Tokens / 0 API Calls** on fresh MVP start, accumulating real tokens as the user interacts with the application.
   - Usage telemetry is persisted locally in `data/api_usage.json` so cumulative token consumption and cost data carry over across server restarts.

2. **Real-Time Token Metering**:
   - **Executive Chat completions**: Real prompt tokens and completion tokens returned by Azure OpenAI responses are metered and added to cumulative totals.
   - **Document Vector Embeddings**: Actual text length parsed from uploaded PDF, Word, Excel, and PPT files is measured and converted to embedding tokens.
   - **Vector Similarity Search Queries**: Queries run via the Vector RAG Query Tester meter real embedding API calls.

3. **Removed Hardcoded Dummy Placeholders**:
   - Cleared static sample document rows (`Joensuu_Strategy_2026.md`, `Bioeconomy_Jobs_Report_2026.xlsx`, etc.).
   - Connected document tables and summary lists to the live backend endpoint (`GET /api/documents/list`).
   - Connected the RAG Vector Search Query Tester to `POST /api/documents/query`, displaying actual cosine similarity scores and passages from uploaded files.

---

## 2. Technical Changes Breakdown

### A. Backend API (`kernel/server.py`, `kernel/rag/doc_store.py`)
- Created `load_billing_data()` and `save_billing_data()` to manage persistent billing state in `data/api_usage.json`.
- Added endpoints:
  - `GET /api/billing/usage`: Serves current spend ($), budget limit ($), token counts, call count, and per-model cost breakdowns.
  - `POST /api/billing/budget`: Allows users to update their monthly budget ceiling.
  - `GET /api/documents/list`: Returns list of actual indexed documents in the vector store.
  - `POST /api/documents/query`: Performs real cosine similarity vector search over uploaded documents and meters API usage.
- Instrument `chat_endpoint` and `upload_document_endpoint` to record token consumption and USD costs automatically.

### B. Frontend UI & Telemetry (`ui/index.html`, `ui/src/main.ts`, `ui/src/style.css`)
- **Header Spend Pill (`#open-billing-btn`)**: Displays live MTD API spend against budget cap (e.g. `$0.00 / $50.00`).
- **AWS Cloud Billing Panel on Dashboard**: Renders real-time spend bar, daily burn rate ($/day), estimated end-of-month bill, input/output tokens, total calls, average latency, and per-model cost breakdowns.
- **AWS Cost Explorer Modal (`#billing-modal`)**: Provides a detailed breakdown of usage by deployment model (`mvp-gpt-54-mini`, `mvp-embed-small`, `mvp-gpt-54`) with an interactive budget update form.
- **Dynamic Document Library & RAG Tester**: Loads indexed documents via `fetchDocumentList()` and executes real semantic searches via `runVectorSearchTest()`.

---

## 3. Verification & Build Confirmation

- **Vite Build**: Built production bundle cleanly with `npm run build` (`dist/index.html`, `dist/assets/index-DTDv9-GQ.css`, `dist/assets/index-D0Y-wBx9.js`).
- **Backend Server**: Verified FastAPI kernel startup on `http://127.0.0.1:8000`.
- **Vite Dev Server**: Running live on `http://localhost:3000`.
