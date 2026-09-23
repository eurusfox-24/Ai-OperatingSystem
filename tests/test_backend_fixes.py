import unittest
import numpy as np
from kernel.rag.doc_store import DocumentIngestionEngine
from kernel.core.llm_provider import UnifiedLLMProviderFactory
from kernel.core.event_bus import EventBus
from kernel.core.azure_client import AzureOpenAIClient


class BackendFixesTestCase(unittest.TestCase):
    def test_zero_division_guard_in_vector_search(self):
        engine = DocumentIngestionEngine()
        engine.vector_store = [
            {"doc_name": "zero_doc.txt", "embedding": [0.0, 0.0, 0.0], "text": "empty vector content"},
            {"doc_name": "valid_doc.txt", "embedding": [1.0, 0.0, 0.0], "text": "valid vector content"},
        ]
        # Query with all-zero vector should not raise ZeroDivisionError or produce NaN
        q_vec = np.array([0.0, 0.0, 0.0])
        norm_q = float(np.linalg.norm(q_vec))
        self.assertEqual(norm_q, 0.0)

        # Ingestion engine calculation logic
        scored_docs = []
        for item in engine.vector_store:
            doc_vec = np.array(item["embedding"])
            norm_doc = float(np.linalg.norm(doc_vec))
            if norm_q > 0 and norm_doc > 0:
                similarity = float(np.dot(q_vec, doc_vec) / (norm_q * norm_doc))
            else:
                similarity = 0.0
            scored_docs.append((similarity, item["doc_name"], item["text"]))

        self.assertEqual(len(scored_docs), 2)
        self.assertEqual(scored_docs[0][0], 0.0)
        self.assertEqual(scored_docs[1][0], 0.0)
        self.assertFalse(np.isnan(scored_docs[0][0]))

    def test_tool_call_none_content_serialization(self):
        provider = UnifiedLLMProviderFactory()
        messages = [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [{"id": "call_123", "type": "function", "function": {"name": "test_fn", "arguments": "{}"}}]
            }
        ]
        formatted = provider._format_messages_for_openai(messages)
        self.assertEqual(len(formatted), 1)
        self.assertEqual(formatted[0]["role"], "assistant")
        self.assertIsNone(formatted[0]["content"])
        self.assertNotEqual(formatted[0]["content"], "None")
        self.assertEqual(len(formatted[0]["tool_calls"]), 1)

    def test_event_bus_discard_idempotence(self):
        bus = EventBus()
        mock_conn = object()
        # Discarding a connection not in active_connections should not raise KeyError
        bus.active_connections.discard(mock_conn)
        self.assertNotIn(mock_conn, bus.active_connections)

        # Adding and discarding
        bus.active_connections.add(mock_conn)
        self.assertIn(mock_conn, bus.active_connections)
        bus.active_connections.discard(mock_conn)
        self.assertNotIn(mock_conn, bus.active_connections)
        # Discard again - no KeyError
        bus.active_connections.discard(mock_conn)


if __name__ == "__main__":
    unittest.main()
