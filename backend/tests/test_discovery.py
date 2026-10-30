import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
import main


class DiscoveryApiTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        main.DATABASE = str(Path(self.tempdir.name) / "test-openfolio.db")
        main._rate_buckets.clear()
        main._last_rate_cleanup = 0.0
        original_normalize = main.normalize_public_url

        def no_dns(url, *, resolve_dns=True):
            return original_normalize(url, resolve_dns=False)

        self.normalize_patch = patch.object(main, "normalize_public_url", side_effect=no_dns)
        self.normalize_patch.start()
        main.init_database()
        self.client_context = TestClient(main.app)
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.normalize_patch.stop()
        self.tempdir.cleanup()

    def submit_batch(self, urls):
        return self.client.post("/api/discover/batch", json={
            "feeds": [
                {"name": f"Feed {i}", "url": url, "category": "Technology", "description": "Test feed"}
                for i, url in enumerate(urls)
            ]
        })

    def test_database_seeds_at_least_ten_blogs(self):
        response = self.client.get("/api/discover/popular")
        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(len(response.json()["recommendations"]), 10)

    def test_batch_normalizes_and_deduplicates_urls(self):
        response = self.submit_batch([
            "HTTPS://Example.com/feed/?utm_source=one#top",
            "https://example.com/feed",
        ])
        self.assertEqual(response.status_code, 201, response.text)
        data = response.json()
        self.assertEqual(data["accepted_feeds"], 1)
        self.assertEqual(data["deduplicated_feeds"], 1)

    def test_batch_stores_aggregate_counts_and_popularity(self):
        url_a = "https://example.com/a-feed"
        url_b = "https://example.com/b-feed"
        first = self.submit_batch([url_a, url_b])
        second = self.submit_batch([url_a, url_b])
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(second.status_code, 201, second.text)
        popular = self.client.get("/api/discover/popular").json()["recommendations"]
        row_a = next(row for row in popular if row["url"] == url_a)
        self.assertEqual(row_a["popularity_count"], 2)
        # The database stores aggregate pairs, never a row representing the batch.
        import sqlite3
        db = sqlite3.connect(main.DATABASE)
        try:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("co_subscription_pairs", tables)
            self.assertNotIn("anonymous_batches", tables)
        finally:
            db.close()

    def test_co_subscription_recommendation_explains_why_and_excludes_followed(self):
        url_a = "https://example.com/a-feed"
        url_b = "https://example.com/b-feed"
        self.submit_batch([url_a, url_b])
        self.submit_batch([url_a, url_b])
        response = self.client.post("/api/discover/recommendations", json={"subscriptions": [url_a]})
        self.assertEqual(response.status_code, 200, response.text)
        results = response.json()["recommendations"]
        self.assertNotIn(url_a, [row["url"] for row in results])
        row_b = next(row for row in results if row["url"] == url_b)
        self.assertEqual(row_b["recommendation_basis"], "co_subscription")
        self.assertIn("Often followed alongside", row_b["reason"])

    def test_batch_size_is_capped(self):
        response = self.client.post("/api/discover/batch", json={"feeds": [
            {"name": f"Feed {i}", "url": f"https://example.com/feed-{i}"}
            for i in range(51)
        ]})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
