#!/bin/bash
# run_ai_os.sh
# Linux launch script for The Company AI OS

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=======================================${NC}"
echo -e "${GREEN}  The Company AI OS - Launch Sequence ${NC}"
echo -e "${BLUE}=======================================${NC}"

# Refuse to replace an existing service on the project ports.
echo -e "\n${BLUE}[1/4] Checking local ports...${NC}"
if command -v lsof >/dev/null 2>&1 && { lsof -iTCP:8000 -sTCP:LISTEN -t >/dev/null || lsof -iTCP:3000 -sTCP:LISTEN -t >/dev/null; }; then
    echo "Port 8000 or 3000 is already in use. Stop the existing service and retry."
    exit 1
fi

# Activate python virtual environment and start backend
echo -e "\n${BLUE}[2/4] Starting FastAPI Kernel (Port 8000)...${NC}"
if [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
elif [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
else
    echo "Virtual environment not found, creating environment..."
    if command -v uv >/dev/null 2>&1; then
        echo "Using uv to create virtual environment..."
        uv venv .venv
        source .venv/bin/activate
        uv pip install -r kernel/requirements.txt
    elif command -v python3 >/dev/null 2>&1; then
        echo "uv not found, falling back to python3 -m venv..."
        python3 -m venv .venv
        source .venv/bin/activate
        pip install -r kernel/requirements.txt
    else
        echo "Error: Neither uv nor python3 found. Please install Python 3 or uv."
        exit 1
    fi
fi


# Run uvicorn in the background
nohup python -m kernel.main > kernel_backend.log 2>&1 &
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
