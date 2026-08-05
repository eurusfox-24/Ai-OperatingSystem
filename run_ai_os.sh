#!/bin/bash
# run_ai_os.sh
# Linux launch script for Forest Joensuu AI OS

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=======================================${NC}"
echo -e "${GREEN}  Forest Joensuu AI OS - Launch Sequence ${NC}"
echo -e "${BLUE}=======================================${NC}"

# Stop any running processes on our ports
echo -e "\n${BLUE}[1/4] Cleaning up existing ports...${NC}"
fuser -k 8000/tcp 2>/dev/null
fuser -k 3000/tcp 2>/dev/null

# Activate python virtual environment and start backend
echo -e "\n${BLUE}[2/4] Starting FastAPI Kernel (Port 8000)...${NC}"
if [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
else
    echo "Virtual environment not found in .venv/bin/activate, trying to run uv..."
    uv venv .venv
    source .venv/bin/activate
    uv pip install -r requirements.txt
fi

# Run uvicorn in the background
nohup uvicorn kernel.server:app --reload --port 8000 --host 0.0.0.0 > kernel_backend.log 2>&1 &
BACKEND_PID=$!
echo "Backend running at PID: $BACKEND_PID"

# Start Frontend UI
echo -e "\n${BLUE}[3/4] Starting Vite Dashboard (Port 3000)...${NC}"
cd ui
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm install
fi

# Run vite in the background
nohup npm run dev > frontend_ui.log 2>&1 &
FRONTEND_PID=$!
echo "Frontend running at PID: $FRONTEND_PID"
cd ..

echo -e "\n${BLUE}[4/4] Opening AI OS Dashboard...${NC}"
sleep 2

# Try to open the browser automatically
if command -v xdg-open &> /dev/null; then
    xdg-open http://localhost:3000
elif command -v open &> /dev/null; then
    open http://localhost:3000
else
    echo -e "${GREEN}Please open your browser to: http://localhost:3000${NC}"
fi

echo -e "\n${GREEN}All systems operational! Press Ctrl+C to terminate.${NC}"

# Wait for trap
trap "echo -e '\n${BLUE}Shutting down AI OS...${NC}'; kill $BACKEND_PID; kill $FRONTEND_PID; exit" INT TERM
wait
