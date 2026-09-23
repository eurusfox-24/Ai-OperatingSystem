import asyncio
import os
import tempfile
import unittest

from kernel.connectors.rss import FeedValidationError, parse_feed, validate_public_feed_url
from kernel.connectors.service import ConnectorService
from kernel.db.local_manager import db_manager
from kernel.tools.web_scraper import WebScraperEngine


RSS_SAMPLE = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>EU Opportunities</title>
<item><guid>one</guid><title>Forestry youth skills funding</title>
<link>https://example.com/one</link><description><![CDATA[Funding for circular forestry education in North Karelia.]]></description>
<pubDate>Mon, 17 Aug 2026 09:00:00 GMT</pubDate></item>
</channel></rss>"""


class ConnectorTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db_path = db_manager.db_path
        db_manager.db_path = os.path.join(self.tempdir.name, "connector-test.db")
        db_manager._init_database()

    def tearDown(self):
        db_manager.db_path = self.original_db_path
        self.tempdir.cleanup()

    def test_rss_is_normalised_and_html_is_removed(self):
        feed = parse_feed(RSS_SAMPLE, "https://example.com/feed.xml")
        self.assertEqual(feed["title"], "EU Opportunities")
        self.assertEqual(feed["items"][0]["external_id"], "one")
        self.assertNotIn("<![CDATA", feed["items"][0]["summary"])
        self.assertEqual(feed["items"][0]["published_at"], "2026-08-17T09:00:00Z")

    def test_private_network_feed_is_blocked(self):
        with self.assertRaises(FeedValidationError):
            validate_public_feed_url("http://127.0.0.1/feed.xml")
        with self.assertRaises(FeedValidationError):
            validate_public_feed_url("https://user:password@example.com/feed.xml", resolve=False)
        with self.assertRaises(FeedValidationError):
            validate_public_feed_url("https://example.com:invalid/feed.xml", resolve=False)

    def test_web_research_blocks_private_and_non_web_targets(self):
        self.assertIsNone(WebScraperEngine._validate_public_url("http://127.0.0.1/admin"))
        self.assertIsNone(WebScraperEngine._validate_public_url("file:///etc/passwd"))
        self.assertIsNone(WebScraperEngine._validate_public_url("https://example.com:8080/private"))

    async def test_sync_persists_scored_deduplicated_signals(self):
        def fake_fetcher(url):
            return parse_feed(RSS_SAMPLE, url)

        service = ConnectorService(feed_fetcher=fake_fetcher)
        instance = service.create_instance(
            name="EU feed",
            feed_url="https://example.com/feed.xml",
            interest_query="forestry youth education North Karelia",
            poll_minutes=60,
            enabled=False,
        )
        first = await service.sync_instance(instance["id"])
        second = await service.sync_instance(instance["id"])
        self.assertEqual(first["items_created"], 1)
        self.assertEqual(second["items_created"], 0)
        signals = service.list_signals(instance_id=instance["id"])
        self.assertEqual(len(signals), 1)
        self.assertGreaterEqual(signals[0]["relevance_score"], 50)
        self.assertIn("forestry", signals[0]["relevance_reason"])


if __name__ == "__main__":
    unittest.main()
