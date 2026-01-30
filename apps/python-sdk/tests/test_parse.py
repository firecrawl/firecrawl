import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from firecrawl.v2.client import FirecrawlClient


class DummyResponse:
    ok = True

    def json(self):
        return {"success": True, "data": {"markdown": "ok", "metadata": {"statusCode": 200}}}


def test_parse_multipart_upload():
    client = FirecrawlClient(api_url="http://localhost:3000")
    client.http_client.post_multipart = MagicMock(return_value=DummyResponse())

    fixture = Path(__file__).resolve().parent / "fixtures" / "sample.md"
    assert fixture.exists()

    doc = client.parse(
        str(fixture),
        formats=["markdown"],
        filename="sample.md",
    )

    assert doc.markdown == "ok"
    client.http_client.post_multipart.assert_called_once()

    endpoint, data, files = client.http_client.post_multipart.call_args[0]
    assert endpoint == "/v2/parse"
    assert "options" in data
    assert json.loads(data["options"])["formats"] == ["markdown"]
    assert files["file"][0] == "sample.md"
