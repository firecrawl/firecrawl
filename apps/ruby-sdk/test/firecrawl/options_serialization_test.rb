# frozen_string_literal: true

require_relative "../test_helper"

class OptionsSerializationTest < Minitest::Test
  def test_search_options_include_country
    opts = Firecrawl::Models::SearchOptions.new(country: "DE", enterprise: ["zdr"])
    payload = opts.to_h

    assert_equal "DE", payload["country"]
    assert_equal ["zdr"], payload["enterprise"]
  end

  def test_crawl_options_include_robots_fields
    opts = Firecrawl::Models::CrawlOptions.new(
      ignore_robots_txt: true,
      robots_user_agent: "MyBot/1.0"
    )
    payload = opts.to_h

    assert_equal true, payload["ignoreRobotsTxt"]
    assert_equal "MyBot/1.0", payload["robotsUserAgent"]
  end

  def test_scrape_options_include_min_age_and_profile
    opts = Firecrawl::Models::ScrapeOptions.new(
      min_age: 1000,
      profile: { "name" => "my-profile", "saveChanges" => false }
    )
    payload = opts.to_h

    assert_equal 1000, payload["minAge"]
    assert_equal({ "name" => "my-profile", "saveChanges" => false }, payload["profile"])
  end

  def test_omits_unset_optional_fields
    search = Firecrawl::Models::SearchOptions.new(limit: 5).to_h
    crawl = Firecrawl::Models::CrawlOptions.new(limit: 10).to_h
    scrape = Firecrawl::Models::ScrapeOptions.new(timeout: 5000).to_h

    refute search.key?("country")
    refute crawl.key?("ignoreRobotsTxt")
    refute scrape.key?("minAge")
    refute scrape.key?("profile")
  end
end
