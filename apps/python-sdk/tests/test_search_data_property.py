import pytest
from firecrawl.v2.types import SearchData, SearchResultWeb, SearchResultNews


class TestSearchDataDotData:
    def test_raises_with_web_results(self):
        sd = SearchData(web=[SearchResultWeb(title="T", url="http://a.com")])
        with pytest.raises(AttributeError, match=r"\.web \(1 results\)"):
            sd.data

    def test_raises_with_multiple_sources(self):
        sd = SearchData(
            web=[SearchResultWeb(title="T", url="http://a.com")],
            news=[SearchResultNews(title="N", url="http://b.com")],
        )
        with pytest.raises(AttributeError, match=r"\.web.*\.news"):
            sd.data

    def test_raises_with_empty_response(self):
        sd = SearchData()
        with pytest.raises(AttributeError, match="grouped by source"):
            sd.data

    def test_web_still_works(self):
        sd = SearchData(web=[SearchResultWeb(title="T", url="http://a.com")])
        assert len(sd.web) == 1
        assert sd.web[0].title == "T"
