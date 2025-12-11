import pytest
from unittest.mock import Mock, MagicMock
from firecrawl.v2.methods.scrape import scrape
from firecrawl.v2.types import ScrapeOptions, Document


class TestBrandingFormat:
    """Unit tests for branding format support."""

    def test_scrape_with_branding_format_returns_branding_data(self):
        """Test that scraping with branding format returns branding data."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Example",
                "branding": {
                    "colorScheme": "light",
                    "colors": {
                        "primary": "#E11D48",
                        "secondary": "#3B82F6",
                        "accent": "#F59E0B"
                    },
                    "typography": {
                        "fontFamilies": {
                            "primary": "Inter",
                            "heading": "Poppins"
                        },
                        "fontSizes": {
                            "h1": "2.5rem",
                            "body": "1rem"
                        }
                    },
                    "spacing": {
                        "baseUnit": 8
                    },
                    "components": {
                        "buttonPrimary": {
                            "background": "#E11D48",
                            "textColor": "#FFFFFF",
                            "borderRadius": "0.5rem"
                        }
                    }
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["branding"]))

        assert result.branding is not None
        assert result.branding.color_scheme == "light"
        assert result.branding.colors["primary"] == "#E11D48"
        assert result.branding.typography["fontFamilies"]["primary"] == "Inter"
        assert result.branding.spacing["baseUnit"] == 8
        assert result.branding.components["buttonPrimary"]["background"] == "#E11D48"

    def test_scrape_with_branding_and_markdown_formats_returns_both(self):
        """Test that scraping with both branding and markdown formats returns both."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Example Content",
                "branding": {
                    "colorScheme": "dark",
                    "colors": {
                        "primary": "#10B981"
                    },
                    "typography": {
                        "fontFamilies": {
                            "primary": "Roboto"
                        }
                    }
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["markdown", "branding"]))

        assert result.markdown == "# Example Content"
        assert result.branding is not None
        assert result.branding.color_scheme == "dark"
        assert result.branding.colors["primary"] == "#10B981"

    def test_scrape_without_branding_format_does_not_return_branding(self):
        """Test that scraping without branding format does not return branding."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Example"
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["markdown"]))

        assert result.markdown == "# Example"
        assert result.branding is None

    def test_branding_format_with_all_nested_fields(self):
        """Test branding format with all nested fields populated."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "branding": {
                    "colorScheme": "light",
                    "logo": "https://example.com/logo.png",
                    "fonts": [
                        {"family": "Inter", "weight": 400},
                        {"family": "Poppins", "weight": 700}
                    ],
                    "colors": {
                        "primary": "#E11D48",
                        "background": "#FFFFFF"
                    },
                    "typography": {
                        "fontFamilies": {"primary": "Inter"},
                        "fontStacks": {"body": ["Inter", "sans-serif"]},
                        "fontSizes": {"h1": "2.5rem"},
                        "lineHeights": {"body": 1.5},
                        "fontWeights": {"regular": 400}
                    },
                    "spacing": {
                        "baseUnit": 8,
                        "padding": {"sm": 8, "md": 16}
                    },
                    "components": {
                        "buttonPrimary": {
                            "background": "#E11D48",
                            "textColor": "#FFFFFF"
                        }
                    },
                    "icons": {
                        "style": "outline",
                        "primaryColor": "#E11D48"
                    },
                    "images": {
                        "logo": "https://example.com/logo.png",
                        "favicon": "https://example.com/favicon.ico"
                    },
                    "animations": {
                        "transitionDuration": "200ms",
                        "easing": "ease-in-out"
                    },
                    "layout": {
                        "grid": {"columns": 12, "maxWidth": "1200px"},
                        "headerHeight": "64px"
                    },
                    "tone": {
                        "voice": "professional",
                        "emojiUsage": "minimal"
                    },
                    "personality": {
                        "tone": "professional",
                        "energy": "medium",
                        "targetAudience": "developers"
                    }
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["branding"]))

        assert result.branding is not None
        assert result.branding.color_scheme == "light"
        assert result.branding.logo == "https://example.com/logo.png"
        assert len(result.branding.fonts) == 2
        assert result.branding.typography["fontStacks"]["body"] == ["Inter", "sans-serif"]
        assert result.branding.spacing["padding"] == {"sm": 8, "md": 16}
        assert result.branding.icons["style"] == "outline"
        assert result.branding.images["favicon"] == "https://example.com/favicon.ico"
        assert result.branding.animations["easing"] == "ease-in-out"
        assert result.branding.layout["grid"]["columns"] == 12
        assert result.branding.personality["tone"] == "professional"

    def test_branding_colorscheme_normalization(self):
        """Test that colorScheme is normalized to color_scheme."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "branding": {
                    "colorScheme": "dark",
                    "colors": {"primary": "#000000"}
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["branding"]))

        assert result.branding is not None
        assert result.branding.color_scheme == "dark"
        assert not hasattr(result.branding, "colorScheme")
