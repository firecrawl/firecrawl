import importlib
import warnings

import firecrawl.v2.types as v2_types


def test_monitor_json_fields_do_not_warn_on_import():
    with warnings.catch_warnings(record=True) as seen:
        warnings.simplefilter("always")
        importlib.reload(v2_types)

    messages = [str(warning.message) for warning in seen]
    assert not any("MonitorPageDiff" in message for message in messages)
    assert not any("MonitorPageSnapshot" in message for message in messages)
