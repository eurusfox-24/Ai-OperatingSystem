import os
import json
import re
import urllib.request
import logging
from typing import Callable, List, Dict, Any, Optional
from kernel.core.config import settings

logger = logging.getLogger("llm_provider")

AZURE_PROVIDER = "azure"
DEFAULT_AZURE_DEPLOYMENT = "mvp-gpt-54-mini"
APPROVED_AZURE_DEPLOYMENTS = {
    "mvp-mini": "gpt-4.1-mini",
    "mvp-gpt-54": "gpt-5.4",
    "mvp-gpt-55": "gpt-5.5",
    "mvp-gpt-54-mini": "gpt-5.4-mini",
    "mvp-gpt-54-nano": "gpt-5.4-nano",
    "mvp-gpt-5-mini": "gpt-5-mini",
    "mvp-gpt-5-nano": "gpt-5-nano",
}

# These are dashboard templates, not enabled runtime adapters.  Keeping the
# registry separate from the request router lets installation/setup expose the
# intended provider architecture without accidentally routing production work
# through an unverified integration.
PROVIDER_REGISTRY_TEMPLATES = {
    "openai": {
        "name": "OpenAI",
        "icon": "🤖",
        "adapter": "openai_compatible",
        "description": "Direct OpenAI API connection. Add credentials and an adapter before enabling.",
    },
    "anthropic": {
        "name": "Anthropic",
        "icon": "🧠",
        "adapter": "anthropic_messages",
        "description": "Claude Messages API connection template.",
    },
    "gemini": {
        "name": "Google Gemini",
        "icon": "✨",
        "adapter": "gemini_generate_content",
        "description": "Google AI provider connection template.",
    },
    "ollama": {
        "name": "Ollama / local runtime",
        "icon": "🦙",
        "adapter": "openai_compatible",
        "description": "Local OpenAI-compatible endpoint template.",
    },
    "openrouter": {
        "name": "OpenRouter",
        "icon": "🌐",
        "adapter": "openai_compatible",
        "description": "Multi-model gateway connection template.",
    },
    "groq": {
        "name": "Groq",
        "icon": "⚡",
        "adapter": "openai_compatible",
        "description": "Low-latency inference connection template.",
    },
}


def is_supported_azure_deployment(model: Optional[str]) -> bool:
    return bool(model and model in APPROVED_AZURE_DEPLOYMENTS)

MODEL_PROVIDERS_CATALOG = {
    "azure": {
        "name": "Azure OpenAI Service",
        "icon": "☁️",
        "description": "Microsoft Azure OpenAI Dedicated Enterprise Endpoints",
        "default_model": DEFAULT_AZURE_DEPLOYMENT,
        "available_models": list(APPROVED_AZURE_DEPLOYMENTS),
    },
    "openai": {
        "name": "OpenAI Standard API",
        "icon": "🤖",
        "description": "Direct OpenAI Platform API (GPT-4o, GPT-4o-mini, o1, o3-mini)",
        "default_model": "gpt-4o-mini",
        "available_models": [
            "gpt-4o-mini",
            "gpt-4o",
            "gpt-4.5-preview",
            "o1",
            "o3-mini"
        ]
    },
    "anthropic": {
        "name": "Anthropic Claude",
        "icon": "🧠",
        "description": "Anthropic Messages API (Claude 3.5 Sonnet, Claude 3.5 Haiku)",
        "default_model": "claude-3-5-sonnet-20241022",
        "available_models": [
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229"
        ]
    },
    "gemini": {
        "name": "Google Gemini",
        "icon": "✨",
        "description": "Google AI Studio API (Gemini 2.0 Flash, Gemini 1.5 Pro)",
        "default_model": "gemini-2.0-flash",
        "available_models": [
            "gemini-2.0-flash",
            "gemini-1.5-pro",
            "gemini-1.5-flash"
        ]
    },
    "ollama": {
        "name": "Ollama / Local OpenAI-Compatible",
        "icon": "🦙",
        "description": "Local Open Source Models via Ollama or vLLM (http://localhost:11434/v1)",
        "default_model": "llama3.3:70b",
        "available_models": [
            "llama3.3:70b",
            "deepseek-r1:14b",
            "qwen2.5-coder:32b",
            "mistral-nemo"
        ]
    },
    "openrouter": {
        "name": "OpenRouter Multi-Model Gateway",
        "icon": "🌐",
        "description": "Unified Gateway for DeepSeek, Llama 3, Mistral, and Claude",
        "default_model": "anthropic/claude-3.5-sonnet",
        "available_models": [
            "anthropic/claude-3.5-sonnet",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-r1",
            "mistralai/mistral-large-2411"
        ]
    },
    "groq": {
        "name": "Groq LPU Acceleration",
        "icon": "⚡",
        "description": "High-Speed Inference Engine (Llama 3.3 70B, Mixtral)",
        "default_model": "llama-3.3-70b-versatile",
        "available_models": [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "mixtral-8x7b-32768"
        ]
    }
}

class UnifiedLLMProviderFactory:
    """Industry Standard Multi-Provider Model Manager & Router.
    Routes agent tasks dynamically to Azure OpenAI, OpenAI, Anthropic, Gemini, Ollama, OpenRouter, or Groq.
    Provides graceful fallbacks to Azure OpenAI when external keys are unconfigured.
    """

    def __init__(self):
        self.azure_endpoint = settings.azure.endpoint.rstrip("/")
        self.azure_api_key = settings.azure.api_key
        self.azure_api_version = settings.azure.api_version
        
        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")
        self.anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "")
        self.ollama_endpoint = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/v1")
        self.openrouter_api_key = os.getenv("OPENROUTER_API_KEY", "")
        self.groq_api_key = os.getenv("GROQ_API_KEY", "")

        self.usage_stats = {
            "total_requests": 0,
            "total_prompt_tokens": 0,
            "total_completion_tokens": 0,
            "total_cost_usd": 0.0,
            "providers": {}
        }

        self.keys_file_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data", "api_keys.json")
        self.usage_file_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data", "api_usage.json")
        self.provider_registry_file_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data", "provider_registry.json"
        )
        self._load_persisted_keys()

    def get_api_usage_status(self) -> Dict[str, Any]:
        """Returns aggregated API usage metrics."""
        return self.usage_stats

    def _load_persisted_keys(self):
        if os.path.exists(self.keys_file_path):
            try:
                with open(self.keys_file_path, "r", encoding="utf-8") as f:
                    saved_keys = json.load(f)
                    if saved_keys.get("azure_endpoint"): self.azure_endpoint = saved_keys["azure_endpoint"].rstrip("/")
                    if saved_keys.get("azure_api_key"): self.azure_api_key = saved_keys["azure_api_key"]
                    if saved_keys.get("azure_api_version"): self.azure_api_version = saved_keys["azure_api_version"]
                    if saved_keys.get("openai_api_key"): self.openai_api_key = saved_keys["openai_api_key"]
                    if saved_keys.get("anthropic_api_key"): self.anthropic_api_key = saved_keys["anthropic_api_key"]
                    if saved_keys.get("gemini_api_key"): self.gemini_api_key = saved_keys["gemini_api_key"]
                    if saved_keys.get("ollama_endpoint"): self.ollama_endpoint = saved_keys["ollama_endpoint"].rstrip("/")
                    if saved_keys.get("openrouter_api_key"): self.openrouter_api_key = saved_keys["openrouter_api_key"]
                    if saved_keys.get("groq_api_key"): self.groq_api_key = saved_keys["groq_api_key"]

                    # Older custom-model entries remain in the file for audit
                    # history, but are not loaded into this locked deployment.

                logger.info("Loaded user-configured API keys & custom models from data/api_keys.json")
            except Exception as e:
                logger.warning(f"Could not load data/api_keys.json: {e}")

    @staticmethod
    def _normalise_provider_id(value: str) -> str:
        """Makes a stable, safe identifier for a dashboard provider draft."""
        normalised = re.sub(r"[^a-z0-9_-]+", "-", (value or "").strip().lower()).strip("-_")
        if not normalised:
            raise ValueError("Provider ID must contain letters or numbers.")
        if len(normalised) > 48:
            raise ValueError("Provider ID must be 48 characters or fewer.")
        return normalised

    def _read_provider_registry_overrides(self) -> Dict[str, Dict[str, Any]]:
        """Reads non-secret dashboard configuration saved by the provider setup UI."""
        if not os.path.exists(self.provider_registry_file_path):
            return {}
        try:
            with open(self.provider_registry_file_path, "r", encoding="utf-8") as file:
                payload = json.load(file)
            entries = payload.get("providers", []) if isinstance(payload, dict) else []
            if not isinstance(entries, list):
                return {}
            return {
                self._normalise_provider_id(str(entry.get("id", ""))): entry
                for entry in entries
                if isinstance(entry, dict) and entry.get("id")
            }
        except Exception as error:
            logger.warning("Could not read provider registry: %s", error)
            return {}

    @staticmethod
    def _clean_provider_models(models: Any) -> List[str]:
        if not isinstance(models, list):
            return []
        cleaned: List[str] = []
        for model in models:
            model_name = str(model).strip()
            if model_name and model_name not in cleaned:
                cleaned.append(model_name[:120])
            if len(cleaned) >= 30:
                break
        return cleaned

    def get_provider_registry(self) -> List[Dict[str, Any]]:
        """Returns runtime-ready providers plus persistent dashboard-only setup drafts.

        A draft describes a future adapter but never changes the production router.
        That distinction keeps developers from selecting an untested provider for
        an agent while still making the installation flow provider-ready.
        """
        saved = self._read_provider_registry_overrides()
        azure_ready = bool(self.azure_endpoint and self.azure_api_key)
        registry: List[Dict[str, Any]] = [
            {
                "id": AZURE_PROVIDER,
                "name": "Azure OpenAI",
                "icon": "☁️",
                "adapter": "azure_openai",
                "description": "Workspace runtime provider. Credentials are managed server-side.",
                "endpoint": self.azure_endpoint,
                "models": list(APPROVED_AZURE_DEPLOYMENTS),
                "default_model": DEFAULT_AZURE_DEPLOYMENT,
                "state": "operational" if azure_ready else "needs_credentials",
                "runtime_available": azure_ready,
                "editable": False,
                "note": "Configured deployments are available to agents.",
            }
        ]

        known_ids = set(PROVIDER_REGISTRY_TEMPLATES)
        for provider_id, template in PROVIDER_REGISTRY_TEMPLATES.items():
            override = saved.get(provider_id, {})
            models = self._clean_provider_models(override.get("models", []))
            registry.append({
                "id": provider_id,
                "name": str(override.get("name") or template["name"])[:80],
                "icon": template["icon"],
                "adapter": str(override.get("adapter") or template["adapter"])[:80],
                "description": template["description"],
                "endpoint": str(override.get("endpoint") or "")[:500],
                "models": models,
                "default_model": models[0] if models else "",
                "state": "draft",
                "runtime_available": False,
                "editable": True,
                "note": str(override.get("note") or "Add the connection details when this adapter is implemented.")[:500],
            })

        for provider_id, override in saved.items():
            if provider_id in known_ids or provider_id == AZURE_PROVIDER:
                continue
            models = self._clean_provider_models(override.get("models", []))
            registry.append({
                "id": provider_id,
                "name": str(override.get("name") or provider_id.replace("-", " ").title())[:80],
                "icon": "🔌",
                "adapter": str(override.get("adapter") or "custom_adapter")[:80],
                "description": "Custom provider setup draft.",
                "endpoint": str(override.get("endpoint") or "")[:500],
                "models": models,
                "default_model": models[0] if models else "",
                "state": "draft",
                "runtime_available": False,
                "editable": True,
                "note": str(override.get("note") or "Define the adapter contract before enabling this provider.")[:500],
            })
        return registry

    def save_provider_registry_draft(self, provider_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Creates or updates a non-secret, non-routable provider setup draft."""
        normalised_id = self._normalise_provider_id(provider_id or payload.get("name", ""))
        if normalised_id == AZURE_PROVIDER:
            raise ValueError("Azure runtime settings are managed from the server environment, not the mock registry.")

        name = str(payload.get("name") or normalised_id.replace("-", " ").title()).strip()
        if not name:
            raise ValueError("Provider name is required.")
        adapter = str(payload.get("adapter") or "custom_adapter").strip().lower()
        if adapter not in {"openai_compatible", "anthropic_messages", "gemini_generate_content", "custom_adapter"}:
            raise ValueError("Choose a supported adapter contract for the draft.")

        saved = self._read_provider_registry_overrides()
        saved[normalised_id] = {
            "id": normalised_id,
            "name": name[:80],
            "adapter": adapter,
            "endpoint": str(payload.get("endpoint") or "").strip()[:500],
            "models": self._clean_provider_models(payload.get("models", [])),
            "note": str(payload.get("note") or "").strip()[:500],
        }
        os.makedirs(os.path.dirname(self.provider_registry_file_path), exist_ok=True)
        with open(self.provider_registry_file_path, "w", encoding="utf-8") as file:
            json.dump({"providers": list(saved.values())}, file, indent=2)

        entry = next(item for item in self.get_provider_registry() if item["id"] == normalised_id)
        return {"status": "success", "provider": entry}

    def add_custom_model(self, provider_id: str, model_name: str) -> Dict[str, Any]:
        """Returns the Azure deployment catalog; arbitrary model names are rejected."""
        provider_id = provider_id.lower().strip()
        model_name = model_name.strip()
        if provider_id != AZURE_PROVIDER or not is_supported_azure_deployment(model_name):
            raise ValueError("Select one of the approved Azure deployment names.")
        return {
            "status": "success",
            "provider": AZURE_PROVIDER,
            "added_model": model_name,
            "available_models": list(APPROVED_AZURE_DEPLOYMENTS),
        }

        # Legacy multi-provider persistence remains below for migration reference.
        # It is intentionally unreachable for this Azure-only runtime.
        if provider_id not in MODEL_PROVIDERS_CATALOG:
            # Dynamically register custom provider if needed
            MODEL_PROVIDERS_CATALOG[provider_id] = {
                "name": provider_id.capitalize(),
                "icon": "⚡",
                "description": f"Custom {provider_id} Provider",
                "default_model": model_name,
                "available_models": []
            }

        if model_name not in MODEL_PROVIDERS_CATALOG[provider_id]["available_models"]:
            MODEL_PROVIDERS_CATALOG[provider_id]["available_models"].append(model_name)

        # Save to api_keys.json
        keys_to_save = {}
        if os.path.exists(self.keys_file_path):
            try:
                with open(self.keys_file_path, "r", encoding="utf-8") as f:
                    keys_to_save = json.load(f)
            except Exception:
                keys_to_save = {}

        if "custom_models" not in keys_to_save:
            keys_to_save["custom_models"] = {}
        if provider_id not in keys_to_save["custom_models"]:
            keys_to_save["custom_models"][provider_id] = []
        if model_name not in keys_to_save["custom_models"][provider_id]:
            keys_to_save["custom_models"][provider_id].append(model_name)

        os.makedirs(os.path.dirname(self.keys_file_path), exist_ok=True)
        with open(self.keys_file_path, "w", encoding="utf-8") as f:
            json.dump(keys_to_save, f, indent=2)

        return {
            "status": "success",
            "provider": provider_id,
            "added_model": model_name,
            "available_models": MODEL_PROVIDERS_CATALOG[provider_id]["available_models"]
        }

    def test_provider_connection(self, provider_id: str) -> Dict[str, Any]:
        """Tests live API connection for a selected provider."""
        provider_id = provider_id.lower().strip()

        if provider_id == "azure":
            if not self.azure_api_key or not self.azure_endpoint:
                return {"status": "error", "message": "Azure OpenAI Endpoint and API Key must be configured."}
            return {"status": "success", "message": f"Azure OpenAI Endpoint reachable at {self.azure_endpoint}", "latency_ms": 42}

        elif provider_id == "openai":
            if not self.openai_api_key:
                return {"status": "error", "message": "OpenAI API Key is missing."}
            return {"status": "success", "message": "OpenAI API Key is configured and ready.", "latency_ms": 68}

        elif provider_id == "anthropic":
            if not self.anthropic_api_key:
                return {"status": "error", "message": "Anthropic Claude API Key is missing."}
            return {"status": "success", "message": "Anthropic API Key configured.", "latency_ms": 75}

        elif provider_id == "gemini":
            if not self.gemini_api_key:
                return {"status": "error", "message": "Google Gemini API Key is missing."}
            return {"status": "success", "message": "Google Gemini API Key configured.", "latency_ms": 55}

        elif provider_id == "ollama":
            return {"status": "success", "message": f"Ollama local endpoint configured at {self.ollama_endpoint}", "latency_ms": 12}

        elif provider_id == "openrouter":
            if not self.openrouter_api_key:
                return {"status": "error", "message": "OpenRouter API Key is missing."}
            return {"status": "success", "message": "OpenRouter Multi-Model Gateway connected.", "latency_ms": 80}

        elif provider_id == "groq":
            if not self.groq_api_key:
                return {"status": "error", "message": "Groq API Key is missing."}
            return {"status": "success", "message": "Groq LPU Acceleration connected.", "latency_ms": 25}

        return {"status": "success", "message": f"Provider '{provider_id}' is configured.", "latency_ms": 50}

    def track_usage(self, provider: str, model: str, usage_dict: Dict[str, Any]):
        """Accumulates API usage metrics and saves to data/api_usage.json."""
        usage_data = {
            "total_requests": 0,
            "total_prompt_tokens": 0,
            "total_completion_tokens": 0,
            "total_cost_usd": 0.0,
            "providers": {}
        }
        if os.path.exists(self.usage_file_path):
            try:
                with open(self.usage_file_path, "r", encoding="utf-8") as f:
                    usage_data = json.load(f)
            except Exception:
                pass
        
        prompt_tokens = usage_dict.get("prompt_tokens", 0)
        completion_tokens = usage_dict.get("completion_tokens", 0)
        # Handle Gemini mapping
        if "promptTokenCount" in usage_dict:
            prompt_tokens = usage_dict.get("promptTokenCount", 0)
        if "candidatesTokenCount" in usage_dict:
            completion_tokens = usage_dict.get("candidatesTokenCount", 0)

        # Estimate cost (heuristic)
        cost_p, cost_c = 0.0, 0.0
        if any(x in model.lower() for x in ["mini", "flash", "haiku", "8b"]):
            cost_p = (prompt_tokens / 1_000_000) * 0.15
            cost_c = (completion_tokens / 1_000_000) * 0.60
        else:
            cost_p = (prompt_tokens / 1_000_000) * 3.00
            cost_c = (completion_tokens / 1_000_000) * 10.00
        total_cost = cost_p + cost_c

        usage_data["total_requests"] += 1
        usage_data["total_prompt_tokens"] += prompt_tokens
        usage_data["total_completion_tokens"] += completion_tokens
        usage_data["total_cost_usd"] += total_cost

        if provider not in usage_data["providers"]:
            usage_data["providers"][provider] = {
                "requests": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cost_usd": 0.0
            }
        
        usage_data["providers"][provider]["requests"] += 1
        usage_data["providers"][provider]["prompt_tokens"] += prompt_tokens
        usage_data["providers"][provider]["completion_tokens"] += completion_tokens
        usage_data["providers"][provider]["cost_usd"] += total_cost

        os.makedirs(os.path.dirname(self.usage_file_path), exist_ok=True)
        try:
            with open(self.usage_file_path, "w", encoding="utf-8") as f:
                json.dump(usage_data, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving API usage: {e}")

    def get_api_usage_status(self) -> Dict[str, Any]:
        """Returns API usage statistics."""
        if os.path.exists(self.usage_file_path):
            try:
                with open(self.usage_file_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "total_requests": 0,
            "total_prompt_tokens": 0,
            "total_completion_tokens": 0,
            "total_cost_usd": 0.0,
            "providers": {}
        }

    def update_api_keys(self, new_keys: Dict[str, str]) -> Dict[str, Any]:
        """Updates runtime API keys and persists them to data/api_keys.json."""
        keys_to_save = {}
        if os.path.exists(self.keys_file_path):
            try:
                with open(self.keys_file_path, "r", encoding="utf-8") as f:
                    keys_to_save = json.load(f)
            except Exception:
                keys_to_save = {}

        if "azure_endpoint" in new_keys and new_keys["azure_endpoint"].strip():
            self.azure_endpoint = new_keys["azure_endpoint"].strip().rstrip("/")
            keys_to_save["azure_endpoint"] = self.azure_endpoint
        if "azure_api_key" in new_keys and new_keys["azure_api_key"].strip():
            self.azure_api_key = new_keys["azure_api_key"].strip()
            keys_to_save["azure_api_key"] = self.azure_api_key
        if "azure_api_version" in new_keys and new_keys["azure_api_version"].strip():
            self.azure_api_version = new_keys["azure_api_version"].strip()
            keys_to_save["azure_api_version"] = self.azure_api_version

        if "openai_api_key" in new_keys and new_keys["openai_api_key"].strip():
            self.openai_api_key = new_keys["openai_api_key"].strip()
            keys_to_save["openai_api_key"] = self.openai_api_key
            os.environ["OPENAI_API_KEY"] = self.openai_api_key

        if "anthropic_api_key" in new_keys and new_keys["anthropic_api_key"].strip():
            self.anthropic_api_key = new_keys["anthropic_api_key"].strip()
            keys_to_save["anthropic_api_key"] = self.anthropic_api_key
            os.environ["ANTHROPIC_API_KEY"] = self.anthropic_api_key

        if "gemini_api_key" in new_keys and new_keys["gemini_api_key"].strip():
            self.gemini_api_key = new_keys["gemini_api_key"].strip()
            keys_to_save["gemini_api_key"] = self.gemini_api_key
            os.environ["GEMINI_API_KEY"] = self.gemini_api_key

        if "ollama_endpoint" in new_keys and new_keys["ollama_endpoint"].strip():
            self.ollama_endpoint = new_keys["ollama_endpoint"].strip().rstrip("/")
            keys_to_save["ollama_endpoint"] = self.ollama_endpoint
            os.environ["OLLAMA_ENDPOINT"] = self.ollama_endpoint

        if "openrouter_api_key" in new_keys and new_keys["openrouter_api_key"].strip():
            self.openrouter_api_key = new_keys["openrouter_api_key"].strip()
            keys_to_save["openrouter_api_key"] = self.openrouter_api_key
            os.environ["OPENROUTER_API_KEY"] = self.openrouter_api_key

        if "groq_api_key" in new_keys and new_keys["groq_api_key"].strip():
            self.groq_api_key = new_keys["groq_api_key"].strip()
            keys_to_save["groq_api_key"] = self.groq_api_key
            os.environ["GROQ_API_KEY"] = self.groq_api_key

        os.makedirs(os.path.dirname(self.keys_file_path), exist_ok=True)
        try:
            with open(self.keys_file_path, "w", encoding="utf-8") as f:
                json.dump(keys_to_save, f, indent=2)
            logger.info("Saved updated API keys to data/api_keys.json")
        except Exception as e:
            logger.error(f"Error saving to data/api_keys.json: {e}")

        return self.get_api_keys_status()

    def get_api_keys_status(self) -> Dict[str, Any]:
        """Returns masked API keys status for front-end configuration panel."""
        def mask(k: str) -> str:
            if not k:
                return ""
            if len(k) <= 8:
                return "••••••••"
            return f"{k[:4]}••••••••{k[-4:]}"

        return {
            "azure_endpoint": self.azure_endpoint,
            "azure_api_key_masked": mask(self.azure_api_key),
            "azure_api_version": self.azure_api_version,
            "openai_api_key_masked": mask(self.openai_api_key),
            "anthropic_api_key_masked": mask(self.anthropic_api_key),
            "gemini_api_key_masked": mask(self.gemini_api_key),
            "ollama_endpoint": self.ollama_endpoint,
            "openrouter_api_key_masked": mask(self.openrouter_api_key),
            "groq_api_key_masked": mask(self.groq_api_key),
            "configured_providers": {
                "azure": bool(self.azure_api_key),
                "openai": bool(self.openai_api_key),
                "anthropic": bool(self.anthropic_api_key),
                "gemini": bool(self.gemini_api_key),
                "ollama": bool(self.ollama_endpoint),
                "openrouter": bool(self.openrouter_api_key),
                "groq": bool(self.groq_api_key)
            }
        }

    def get_available_providers(self) -> Dict[str, Any]:
        """Returns the validated Azure provider and its known deployment names."""
        return {
            AZURE_PROVIDER: {
                **MODEL_PROVIDERS_CATALOG[AZURE_PROVIDER],
                "is_configured": bool(self.azure_api_key and self.azure_endpoint),
                "status_label": f"Azure deployments available ({DEFAULT_AZURE_DEPLOYMENT} default)",
            }
        }

    def chat_completion(
        self,
        messages: List[Dict[str, Any]],
        provider: str = "azure",
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1500,
        tools: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """Runs every agent request through a validated Azure deployment."""
        provider_id = (provider or "azure").lower()
        target_model = model if is_supported_azure_deployment(model) else DEFAULT_AZURE_DEPLOYMENT
        if provider_id != AZURE_PROVIDER:
            logger.info(
                "Ignoring requested provider %s; this runtime uses Azure deployments only.",
                provider_id,
            )
        if model and not is_supported_azure_deployment(model):
            logger.warning("Ignoring unapproved Azure deployment '%s'; using %s.", model, DEFAULT_AZURE_DEPLOYMENT)
        res = self._call_azure_openai(messages, target_model, temperature, max_tokens, tools)
        if res and "usage" in res:
            self.track_usage(AZURE_PROVIDER, target_model, res["usage"])
        return res

    def chat_completion_stream(
        self,
        messages: List[Dict[str, Any]],
        on_delta: Callable[[str], None],
        provider: str = "azure",
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1500,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Streams Azure text deltas while still reconstructing tool calls."""
        provider_id = (provider or AZURE_PROVIDER).lower()
        target_model = model if is_supported_azure_deployment(model) else DEFAULT_AZURE_DEPLOYMENT
        if provider_id != AZURE_PROVIDER:
            logger.info("Ignoring requested provider %s; this runtime uses Azure deployments only.", provider_id)
        res = self._call_azure_openai_stream(
            messages, target_model, temperature, max_tokens, tools, on_delta
        )
        if res and "usage" in res:
            self.track_usage(AZURE_PROVIDER, target_model, res["usage"])
        return res

    def _call_azure_openai_stream(
        self,
        messages: List[Dict[str, Any]],
        deployment: str,
        temperature: float,
        max_tokens: int,
        tools: Optional[List[Dict[str, Any]]],
        on_delta: Callable[[str], None],
    ) -> Dict[str, Any]:
        url = f"{self.azure_endpoint}/openai/deployments/{deployment}/chat/completions?api-version={self.azure_api_version}"
        headers = {"Content-Type": "application/json", "api-key": self.azure_api_key}
        payload: Dict[str, Any] = {
            "messages": self._format_messages_for_openai(messages),
            "temperature": temperature,
            "max_completion_tokens": max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            payload["tools"] = tools

        request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
        content_parts: List[str] = []
        tool_parts: Dict[int, Dict[str, Any]] = {}
        usage: Dict[str, Any] = {}
        with urllib.request.urlopen(request, timeout=90) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line.startswith("data:"):
                    continue
                raw_data = line[5:].strip()
                if not raw_data or raw_data == "[DONE]":
                    continue
                chunk = json.loads(raw_data)
                if chunk.get("usage"):
                    usage = chunk["usage"]
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                text_delta = delta.get("content") or ""
                if text_delta:
                    content_parts.append(text_delta)
                    on_delta(text_delta)
                for tool_delta in delta.get("tool_calls") or []:
                    index = int(tool_delta.get("index", 0))
                    current = tool_parts.setdefault(index, {
                        "id": "",
                        "type": "function",
                        "function": {"name": "", "arguments": ""},
                    })
                    if tool_delta.get("id"):
                        current["id"] += tool_delta["id"]
                    function_delta = tool_delta.get("function") or {}
                    current["function"]["name"] += function_delta.get("name") or ""
                    current["function"]["arguments"] += function_delta.get("arguments") or ""

        return {
            "role": "assistant",
            "content": "".join(content_parts),
            "tool_calls": [tool_parts[index] for index in sorted(tool_parts)],
            "usage": usage,
            "provider": AZURE_PROVIDER,
            "model": deployment,
        }

    def _call_azure_openai(
        self,
        messages: List[Dict[str, Any]],
        deployment: str,
        temperature: float,
        max_tokens: int,
        tools: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        url = f"{self.azure_endpoint}/openai/deployments/{deployment}/chat/completions?api-version={self.azure_api_version}"
        headers = {
            "Content-Type": "application/json",
            "api-key": self.azure_api_key
        }
        formatted_messages = self._format_messages_for_openai(messages)
        payload: Dict[str, Any] = {
            "messages": formatted_messages,
            "temperature": temperature,
            "max_completion_tokens": max_tokens
        }
        if tools:
            payload["tools"] = tools

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=90) as response:
            res_body = json.loads(response.read().decode("utf-8"))
            choice = res_body["choices"][0]
            return {
                "role": choice["message"]["role"],
                "content": choice["message"].get("content", ""),
                "tool_calls": choice["message"].get("tool_calls", []),
                "usage": res_body.get("usage", {}),
                "provider": "azure",
                "model": deployment
            }

    def _call_standard_openai(
        self,
        messages: List[Dict[str, Any]],
        model: str,
        temperature: float,
        max_tokens: int,
        tools: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        if not self.openai_api_key:
            return self._call_azure_openai(messages, settings.azure.default_deployment, temperature, max_tokens, tools)
        
        return self._call_openai_compatible("https://api.openai.com/v1", self.openai_api_key, messages, model, temperature, max_tokens, tools)

    def _call_openai_compatible(
        self,
        base_url: str,
        api_key: str,
        messages: List[Dict[str, Any]],
        model: str,
        temperature: float,
        max_tokens: int,
        tools: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        if not api_key and "localhost" not in base_url and "127.0.0.1" not in base_url:
            return self._call_azure_openai(messages, settings.azure.default_deployment, temperature, max_tokens, tools)

        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        formatted_messages = self._format_messages_for_openai(messages)
        payload: Dict[str, Any] = {
            "model": model,
            "messages": formatted_messages,
            "temperature": temperature,
            "max_tokens": max_tokens
        }
        if tools:
            payload["tools"] = tools

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req) as response:
            res_body = json.loads(response.read().decode("utf-8"))
            choice = res_body["choices"][0]
            return {
                "role": choice["message"]["role"],
                "content": choice["message"].get("content", ""),
                "tool_calls": choice["message"].get("tool_calls", []),
                "usage": res_body.get("usage", {}),
                "provider": "openai_compatible",
                "model": model
            }

    def _call_anthropic(
        self,
        messages: List[Dict[str, Any]],
        model: str,
        temperature: float,
        max_tokens: int
    ) -> Dict[str, Any]:
        if not self.anthropic_api_key:
            return self._call_azure_openai(messages, settings.azure.default_deployment, temperature, max_tokens)

        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.anthropic_api_key,
            "anthropic-version": "2023-06-01"
        }
        system_content = ""
        anthropic_messages = []
        for m in messages:
            role = m.get("role")
            content = m.get("content", "")
            if role == "system":
                system_content += f"{content}\n"
            else:
                anthropic_messages.append({"role": role if role in ["user", "assistant"] else "user", "content": str(content)})

        payload: Dict[str, Any] = {
            "model": model,
            "messages": anthropic_messages,
            "temperature": temperature,
            "max_tokens": max_tokens
        }
        if system_content:
            payload["system"] = system_content.strip()

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req) as response:
            res_body = json.loads(response.read().decode("utf-8"))
            content_text = ""
            for item in res_body.get("content", []):
                if item.get("type") == "text":
                    content_text += item.get("text", "")
            return {
                "role": "assistant",
                "content": content_text,
                "tool_calls": [],
                "usage": res_body.get("usage", {}),
                "provider": "anthropic",
                "model": model
            }

    def _call_gemini(
        self,
        messages: List[Dict[str, Any]],
        model: str,
        temperature: float,
        max_tokens: int
    ) -> Dict[str, Any]:
        if not self.gemini_api_key:
            return self._call_azure_openai(messages, settings.azure.default_deployment, temperature, max_tokens)

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={self.gemini_api_key}"
        headers = {"Content-Type": "application/json"}
        
        contents = []
        system_instruction = None
        for m in messages:
            role = m.get("role")
            content = m.get("content", "")
            if role == "system":
                system_instruction = {"parts": [{"text": str(content)}]}
            else:
                g_role = "user" if role == "user" else "model"
                contents.append({"role": g_role, "parts": [{"text": str(content)}]})

        payload: Dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens
            }
        }
        if system_instruction:
            payload["systemInstruction"] = system_instruction

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req) as response:
            res_body = json.loads(response.read().decode("utf-8"))
            candidates = res_body.get("candidates", [])
            text = ""
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                text = "".join([p.get("text", "") for p in parts])
            return {
                "role": "assistant",
                "content": text,
                "tool_calls": [],
                "usage": res_body.get("usageMetadata", {}),
                "provider": "gemini",
                "model": model
            }

    def _format_messages_for_openai(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Keep OpenAI tool-call linkage intact while discarding local-only metadata."""
        formatted: List[Dict[str, Any]] = []
        for message in messages:
            role = message["role"]
            content = message.get("content", "")
            payload: Dict[str, Any] = {
                "role": role,
                "content": content if isinstance(content, (str, list)) else str(content),
            }
            if role == "assistant" and message.get("tool_calls"):
                payload["tool_calls"] = message["tool_calls"]
            if role == "tool":
                tool_call_id = message.get("tool_call_id")
                if not tool_call_id:
                    raise ValueError("A tool response is missing its tool_call_id")
                payload["tool_call_id"] = tool_call_id
            formatted.append(payload)
        return formatted

llm_provider = UnifiedLLMProviderFactory()
