import os
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

class AzureOpenAISettings(BaseModel):
    endpoint: str = os.getenv("AZURE_OPENAI_ENDPOINT", "https://mvp-ai-20260618.openai.azure.com/")
    api_key: str = os.getenv("AZURE_OPENAI_API_KEY", "CPNrDwHbA2MNPz4BHgoHb607A4O9BllVyu9fH4hJF0RsMmfeo4QgJQQJ99CFACfhMk5XJ3w3AAABACOGXPcv")
    api_version: str = os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21")
    default_deployment: str = os.getenv("AZURE_OPENAI_DEPLOYMENT", "mvp-gpt-54-mini")
    high_reasoning_deployment: str = os.getenv("AZURE_OPENAI_HIGH_REASONING", "mvp-gpt-54")
    nano_deployment: str = os.getenv("AZURE_OPENAI_NANO", "mvp-gpt-54-nano")
    embedding_deployment: str = os.getenv("AZURE_OPENAI_EMBEDDING", "mvp-embed-small")

class LocalDBSettings(BaseModel):
    db_path: str = os.getenv("KERNEL_DB_PATH", "data/kernel_workspace.db")

class Settings(BaseModel):
    azure: AzureOpenAISettings = AzureOpenAISettings()
    local_db: LocalDBSettings = LocalDBSettings()
    kernel_port: int = int(os.getenv("KERNEL_PORT", "8000"))
    kernel_host: str = os.getenv("KERNEL_HOST", "0.0.0.0")

settings = Settings()
