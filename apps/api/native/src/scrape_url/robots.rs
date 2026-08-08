use tracing::{info, instrument};

use super::{
  error::ScrapeURLError,
  meta::Meta,
  options::{InternalOptions, ScrapeOptions},
};

fn should_check_robots(options: &ScrapeOptions, internal_options: &InternalOptions) -> bool {
  // TODO: lockdown should be able to fetch some sort of robots.txt cache
  if options.lockdown {
    false
  } else {
    // TODO: internal_options.team_flags.check_robots_on_scrape
    false
  }
}

#[instrument(skip(meta))]
pub async fn do_robots_check_if_needed(meta: &Meta) -> Result<(), ScrapeURLError> {
  if should_check_robots(&meta.options, &meta.internal_options) {
    info!(
      url_to_check = meta.get_url().as_str(),
      "Checking robots.txt"
    );

    // TODO:

    Err(ScrapeURLError::CrawlDenialError)
  } else {
    Ok(())
  }
}
