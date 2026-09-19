import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("shp_server", Path(__file__).parents[1] / "server.py")
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class IntegrationsApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        server_module.INTEGRATIONS_FILE = str(self.root / "integrations.json")
        server_module.DATA_FILE = str(self.root / "data.json")
        server_module.SNAPSHOTS_DIR = str(self.root / "snapshots")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(server_module.AppHandler, directory=str(self.root)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def test_domains_are_sorted_deduplicated_and_sanitized(self):
        (self.root / "integrations.json").write_text(json.dumps([
            {"entry_id": "a", "domain": "zha", "secret": "private"},
            {"entry_id": "b", "domain": "mqtt"}, {"entry_id": "c", "domain": "mqtt"}
        ]))
        with urlopen(self.base + "/api/ha/integrations") as response:
            self.assertEqual(json.load(response), [{"domain": "mqtt"}, {"domain": "zha"}])

    def test_missing_and_corrupt_metadata_return_unavailable(self):
        for value in [None, "not json", "{}"]:
            if value is not None:
                (self.root / "integrations.json").write_text(value)
            with self.assertRaises(HTTPError) as result:
                urlopen(self.base + "/api/ha/integrations")
            self.assertEqual(result.exception.code, 503)
            result.exception.close()

    def test_stale_etag_does_not_overwrite_preferences_or_inventory(self):
        payload = {"devices": [{"id": "one"}], "settings": {"haExcludedIntegrations": []}}
        (self.root / "data.json").write_text(json.dumps(payload))
        request = Request(self.base + "/api/storage", data=json.dumps({"devices": [], "settings": {"haExcludedIntegrations": ["mqtt"]}}).encode(),
                          method="PUT", headers={"Content-Type": "application/json", "If-Match": '"stale"', "X-SHP-Allow-Empty": "1"})
        with self.assertRaises(HTTPError) as result:
            urlopen(request)
        self.assertEqual(result.exception.code, 409)
        result.exception.close()
        self.assertEqual(json.loads((self.root / "data.json").read_text()), payload)


if __name__ == "__main__":
    unittest.main()
