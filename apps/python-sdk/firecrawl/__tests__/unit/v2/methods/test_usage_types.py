from firecrawl.v2.types import ConcurrencyCheck, CreditUsage, TokenUsage


class TestUsageTypes:
    def test_concurrency_check_model(self):
        cc = ConcurrencyCheck(concurrency=3, max_concurrency=10)
        assert cc.concurrency == 3
        assert cc.max_concurrency == 10

    def test_credit_usage_model(self):
        cu = CreditUsage(remaining_credits=123)
        assert isinstance(cu.remaining_credits, int)
        assert cu.remaining_credits == 123

    def test_token_usage_model(self):
        tu = TokenUsage(remaining_tokens=10)
        assert tu.remaining_tokens == 10

