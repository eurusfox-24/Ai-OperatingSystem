# The Company AI OS

Local-first AI workspace for authenticated board chat, project-scoped document retrieval, specialist agents, scheduled work, external signal monitoring, and bounded autonomous goals.

## Start locally

1. Create and activate a Python virtual environment.
2. Install backend dependencies:

   ```powershell
   python -m pip install -r kernel/requirements.txt
   ```

3. Install the UI:

   ```powershell
   cd ui
   npm ci
   cd ..
   ```

4. Configure a local `.env` from `.env.example`.
5. Start with `run_ai_os.bat` on Windows or `./run_ai_os.sh` on Linux/macOS.

The UI is served at `http://127.0.0.1:3000`; the kernel is at `http://127.0.0.1:8000`.

## Verify

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
cd ui
npm run typecheck
npm run build
$env:AI_OS_TEST_PASSWORD = "<temporary test-only password, 12+ characters>"
npm test
```

The browser suite creates isolated temporary users and a temporary database using that value; it never changes the real local accounts or workspace database.

See [PROJECT.md](PROJECT.md) for architecture, orchestration, security, current capabilities, and operational boundaries.
