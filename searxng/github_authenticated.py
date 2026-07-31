# SPDX-License-Identifier: AGPL-3.0-or-later
"""SearXNG GitHub engine with optional token authentication.

The upstream engine does not expose an API-token setting. This wrapper keeps
its request/response behavior while sourcing the token from the container
environment, so credentials never need to be committed to settings.yml.
"""

import os

from searx.engines import github as upstream

about = upstream.about
categories = upstream.categories
search_url = upstream.search_url
accept_header = upstream.accept_header


def request(query, params):
    params = upstream.request(query, params)
    token = os.environ.get("SEARXNG_GITHUB_TOKEN")
    if token:
        params["headers"]["Authorization"] = f"Bearer {token}"
        params["headers"]["X-GitHub-Api-Version"] = "2022-11-28"
    return params


response = upstream.response
