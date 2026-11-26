use firecrawl_crawler::{
  FilterLinksCall, FilterUrlCall, FilterUrlsCall, Robots, extract_links_from_markdown,
  filter_links, filter_url, filter_urls, get_crawl_scope, parse_sitemap_xml, process_sitemap,
};
use hegel::{
  TestCase,
  generators::{self as gs, Generator},
};

const DIRECTIVES: &[&str] = &[
  "User-agent",
  "Disallow",
  "Allow",
  "Crawl-delay",
  "Sitemap",
  "Host",
  "Unknown",
  "",
];

const URL_FRAGMENTS: &[&str] = &[
  "https://example.com/robots.txt",
  "http://www.example.com:8080/path?a=1&b=2",
  "https://www.münich.com/%CF%80/index.html",
  "https://sub.example.co.uk/docs/guide.md",
  "/relative/path",
  "mailto:test@example.com",
  "https://ex ample.com/bad",
  "",
];

const XML_SNIPPETS: &[&str] = &[
  "\u{feff}",
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<!DOCTYPE urlset>",
  "<!ENTITY x \"y\">",
  "<!-- comment -->",
  "<![CDATA[https://example.com/a]]>",
  "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
  "</urlset>",
  "<sitemapindex>",
  "</sitemapindex>",
  "<url><loc>https://example.com/page?a=1&amp;b=2</loc></url>",
  "<url><loc>https://example.com/a&nbsp;b</loc><image:image/></url>",
  "<sitemap><loc>https://example.com/sub.xml</loc></sitemap>",
  "<sm:urlset><sm:url><sm:loc>https://example.com/p</sm:loc></sm:url></sm:urlset>",
];

#[hegel::composite]
fn robots_text(tc: &TestCase) -> String {
  if tc.draw(gs::weighted_booleans(0.25)) {
    return tc.draw(gs::text().max_size(256));
  }
  let lines = tc.draw(gs::integers::<usize>().min_value(0).max_value(12));
  let mut out = String::new();
  if tc.draw(gs::weighted_booleans(0.15)) {
    out.push('\u{feff}');
  }
  for _ in 0..lines {
    let dir = tc.draw(gs::sampled_from(DIRECTIVES));
    let val = tc.draw(gs::text().max_size(48));
    let sep = tc.draw(gs::sampled_from(&["\n", "\r\n", "\r"]));
    if tc.draw(gs::weighted_booleans(0.15)) {
      out.push('#');
    }
    out.push_str(dir);
    if tc.draw(gs::weighted_booleans(0.85)) {
      out.push(':');
    }
    out.push_str(&val);
    out.push_str(sep);
  }
  out
}

#[hegel::composite]
fn maybe_url(tc: &TestCase) -> String {
  tc.draw(hegel::one_of!(
    gs::sampled_from(URL_FRAGMENTS).map(str::to_string),
    gs::text().max_size(96),
  ))
}

#[hegel::composite]
fn xml_input(tc: &TestCase) -> String {
  if tc.draw(gs::weighted_booleans(0.3)) {
    return tc.draw(gs::text().max_size(256));
  }
  let parts = tc.draw(gs::integers::<usize>().min_value(0).max_value(12));
  let mut out = String::new();
  for _ in 0..parts {
    if tc.draw(gs::weighted_booleans(0.7)) {
      out.push_str(tc.draw(gs::sampled_from(XML_SNIPPETS)));
    } else {
      out.push_str(&tc.draw(gs::text().max_size(40)));
    }
  }
  out
}

#[hegel::test]
fn robots_never_panics_on_arbitrary_inputs(tc: TestCase) {
  let robots_url = tc.draw(maybe_url());
  let contents = tc.draw(robots_text());
  let target_url = tc.draw(maybe_url());
  let ua = tc.draw(gs::optional(gs::text().max_size(32)));

  let robots = Robots::parse(&robots_url, &contents);
  let allowed = robots.is_allowed(&target_url, ua.as_deref());
  let disallowed = robots.is_disallowed(&target_url, ua.as_deref());
  assert_eq!(disallowed, allowed != Some(true));

  let line = robots.get_matching_line_number(&target_url, ua.as_deref());
  assert!(line == -1 || line >= 1);

  let _ = robots.get_crawl_delay(ua.as_deref());
  let _ = robots.get_sitemaps();
  let _ = robots.get_preferred_host();
  let agents = ua.map(|agent| vec![agent]);
  let _ = robots.is_url_allowed_by_robots(&target_url, agents.as_deref());
  let batch = robots.filter_urls_allowed(&[target_url], agents.as_deref());
  assert_eq!(batch.len(), 1);
}

#[hegel::test]
fn sitemap_parsers_never_panic_on_arbitrary_xml(tc: TestCase) {
  let xml = tc.draw(xml_input());
  let _ = parse_sitemap_xml(&xml);
  let _ = process_sitemap(&xml);
}

#[hegel::test]
fn link_filters_and_extractors_never_panic_on_arbitrary_inputs(tc: TestCase) {
  let base_url = tc.draw(maybe_url());
  let initial_url = tc.draw(maybe_url());
  let links = tc.draw(gs::vecs(maybe_url()).max_size(8));
  let excludes = tc.draw(gs::vecs(gs::text().max_size(24)).max_size(3));
  let includes = tc.draw(gs::vecs(gs::text().max_size(24)).max_size(3));
  let robots_txt = tc.draw(robots_text());
  let robots_user_agent = tc.draw(gs::optional(gs::text().max_size(24)));
  let limit = tc.draw(gs::optional(
    gs::integers::<i64>().min_value(-5).max_value(16),
  ));
  let max_depth = tc.draw(gs::integers::<u32>().max_value(16));
  let allow_backward = tc.draw(gs::booleans());
  let allow_external = tc.draw(gs::booleans());
  let allow_subdomains = tc.draw(gs::booleans());
  let ignore_robots = tc.draw(gs::booleans());
  let regex_on_full = tc.draw(gs::booleans());

  let scope = get_crawl_scope(&initial_url);
  assert!(scope.prefix.ends_with('/'));

  if let Ok(result) = filter_links(FilterLinksCall {
    links: links.clone(),
    limit,
    max_depth,
    base_url: base_url.clone(),
    initial_url,
    regex_on_full_url: regex_on_full,
    excludes: excludes.clone(),
    includes,
    allow_backward_crawling: allow_backward,
    ignore_robots_txt: ignore_robots,
    robots_txt: robots_txt.clone(),
    robots_user_agent: robots_user_agent.clone(),
    allow_external_content_links: allow_external,
    allow_subdomains,
  }) && let Some(lim) = limit
  {
    let cap = usize::try_from(lim.max(0)).unwrap_or(0);
    assert!(result.links.len() <= cap);
  }

  let href = links.first().cloned().unwrap_or_default();
  let _ = filter_url(FilterUrlCall {
    href,
    url: base_url.clone(),
    base_url: base_url.clone(),
    excludes: excludes.clone(),
    ignore_robots_txt: ignore_robots,
    robots_txt: robots_txt.clone(),
    robots_user_agent: robots_user_agent.clone(),
    allow_external_content_links: allow_external,
    allow_subdomains,
  });

  let _ = filter_urls(FilterUrlsCall {
    hrefs: links,
    url: base_url.clone(),
    base_url: base_url.clone(),
    excludes,
    ignore_robots_txt: ignore_robots,
    robots_txt,
    robots_user_agent,
    allow_external_content_links: allow_external,
    allow_subdomains,
  });

  let markdown = tc.draw(gs::text().max_size(192));
  let _ = extract_links_from_markdown(&markdown, &base_url);
}
