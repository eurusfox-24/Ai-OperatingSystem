import urllib.request
import json
import logging
from typing import List, Dict, Any, Optional
from kernel.core.config import settings

logger = logging.getLogger("azure_client")

class AzureOpenAIClient:
    """Wrapper for Azure OpenAI Chat & Embedding Services."""
    
    def __init__(self, settings_obj=settings):
        self.endpoint = settings_obj.azure.endpoint.rstrip("/")
        self.api_key = settings_obj.azure.api_key
        self.api_version = settings_obj.azure.api_version
        self.default_deployment = settings_obj.azure.default_deployment
        self.embedding_deployment = settings_obj.azure.embedding_deployment

    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        deployment: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1500,
        tools: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        target_deployment = deployment or self.default_deployment
        url = f"{self.endpoint}/openai/deployments/{target_deployment}/chat/completions?api-version={self.api_version}"
        
        headers = {
            "Content-Type": "application/json",
            "api-key": self.api_key
        }
        
        payload: Dict[str, Any] = {
            "messages": messages,
            "temperature": temperature,
            "max_completion_tokens": max_tokens
        }
        if tools:
            payload["tools"] = tools

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        
        try:
            with urllib.request.urlopen(req) as response:
                res_body = json.loads(response.read().decode("utf-8"))
                choice = res_body["choices"][0]
                return {
                    "role": choice["message"]["role"],
                    "content": choice["message"].get("content", ""),
                    "tool_calls": choice["message"].get("tool_calls", []),
                    "usage": res_body.get("usage", {})
                }
        except Exception as e:
            logger.error(f"Azure OpenAI Error ({target_deployment}): {e}")
            raise e

    def get_embedding(self, text: str) -> List[float]:
        url = f"{self.endpoint}/openai/deployments/{self.embedding_deployment}/embeddings?api-version={self.api_version}"
        headers = {
            "Content-Type": "application/json",
            "api-key": self.api_key
        }
        payload = {"input": text}
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        
        try:
            with urllib.request.urlopen(req) as response:
                res_body = json.loads(response.read().decode("utf-8"))
                return res_body["data"][0]["embedding"]
        except Exception as e:
            logger.error(f"Azure OpenAI Embedding Error: {e}")
            raise e

azure_client = AzureOpenAIClient()
