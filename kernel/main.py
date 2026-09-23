import uvicorn
from kernel.core.config import settings

if __name__ == "__main__":
    print(f"Starting AI OS Kernel Daemon on {settings.kernel_host}:{settings.kernel_port} (Isolated Production Mode)...")
    uvicorn.run("kernel.server:app", host=settings.kernel_host, port=settings.kernel_port, reload=False)
