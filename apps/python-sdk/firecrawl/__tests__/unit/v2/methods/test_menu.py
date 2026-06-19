import pytest
from unittest.mock import Mock
from firecrawl.v2.methods.scrape import scrape
from firecrawl.v2.types import ScrapeOptions


class TestMenuFormat:
    """Unit tests for menu format support."""

    def test_scrape_with_menu_format_returns_menu_data(self):
        """Test that scraping with menu format returns menu data."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Example Menu",
                "menu": {
                    "isMenu": True,
                    "confidence": 0.95,
                    "currency": "USD",
                    "sourceUrl": "https://example.com/menu",
                    "merchant": {"name": "Acme Diner", "type": "restaurant"},
                    "sections": [
                        {
                            "id": "mains",
                            "name": "Mains",
                            "description": "Hearty plates",
                            "items": [
                                {
                                    "id": "burger",
                                    "name": "Classic Burger",
                                    "description": "Beef patty with cheese",
                                    "images": [{"url": "https://example.com/burger.jpg", "alt": "Burger"}],
                                    "price": {"amount": 12.5, "currency": "USD", "formatted": "$12.50"},
                                    "availability": {"inStock": True, "text": "Available"},
                                    "dietary": ["contains-gluten"],
                                    "calories": 800,
                                    "optionGroups": [],
                                    "identifiers": {"merchantItemId": "ITEM-1"},
                                    "url": "https://example.com/menu#burger",
                                    "sourceUrl": "https://example.com/menu",
                                }
                            ],
                        }
                    ],
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["menu"]))

        assert result.menu is not None
        assert result.menu.is_menu is True
        assert result.menu.confidence == 0.95
        assert result.menu.currency == "USD"
        assert result.menu.source_url == "https://example.com/menu"
        assert result.menu.merchant.name == "Acme Diner"
        assert result.menu.merchant.type == "restaurant"
        section = result.menu.sections[0]
        assert section.name == "Mains"
        item = section.items[0]
        assert item.name == "Classic Burger"
        assert item.price.amount == 12.5
        assert item.price.currency == "USD"
        assert item.availability.in_stock is True
        assert item.availability.text == "Available"
        assert item.images[0].url == "https://example.com/burger.jpg"
        assert item.dietary[0] == "contains-gluten"
        assert item.calories == 800
        assert item.identifiers.merchant_item_id == "ITEM-1"
        assert item.source_url == "https://example.com/menu"

    def test_scrape_with_menu_and_markdown_formats_returns_both(self):
        """Test that scraping with both menu and markdown formats returns both."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Example Content",
                "menu": {
                    "isMenu": True,
                    "confidence": 0.8,
                    "sourceUrl": "https://example.com/cafe",
                    "merchant": {"name": "Cafe Acme"},
                    "sections": [
                        {
                            "id": "drinks",
                            "name": "Drinks",
                            "items": [
                                {
                                    "id": "coffee",
                                    "name": "Coffee",
                                    "images": [],
                                    "price": {"amount": 3.5, "currency": "USD"},
                                    "availability": {"inStock": True},
                                    "dietary": [],
                                    "optionGroups": [],
                                    "identifiers": {},
                                    "sourceUrl": "https://example.com/cafe",
                                }
                            ],
                        }
                    ],
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["markdown", "menu"]))

        assert result.markdown == "# Example Content"
        assert result.menu is not None
        assert result.menu.merchant.name == "Cafe Acme"
        assert result.menu.sections[0].items[0].price.amount == 3.5

    def test_scrape_without_menu_format_does_not_return_menu(self):
        """Test that scraping without menu format does not return menu."""
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
        assert result.menu is None

    def test_non_menu_page_yields_warning_and_no_menu(self):
        """Test that a non-menu page scraped with menu format yields a warning and no menu."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Blog Post",
                "warning": "No menu found on this page."
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["menu"]))

        assert result.menu is None
        assert "No menu found" in result.warning

    def test_menu_format_with_multiple_sections_and_items(self):
        """Test menu format with multiple sections and items, including camelCase aliasing."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "menu": {
                    "isMenu": True,
                    "confidence": 0.9,
                    "sourceUrl": "https://example.com/menu",
                    "merchant": {"name": "Acme Bistro", "type": "restaurant", "location": {"city": "Springfield"}},
                    "sections": [
                        {
                            "id": "starters",
                            "name": "Starters",
                            "items": [
                                {
                                    "id": "soup",
                                    "name": "Tomato Soup",
                                    "images": [],
                                    "price": {"amount": 6.0, "currency": "USD"},
                                    "availability": {"inStock": True},
                                    "dietary": ["vegetarian"],
                                    "optionGroups": [],
                                    "identifiers": {},
                                    "sourceUrl": "https://example.com/menu",
                                }
                            ],
                        },
                        {
                            "id": "desserts",
                            "name": "Desserts",
                            "items": [
                                {
                                    "id": "cake",
                                    "name": "Chocolate Cake",
                                    "images": [{"url": "https://example.com/cake.jpg"}],
                                    "availability": {"inStock": False, "text": "Sold out"},
                                    "dietary": [],
                                    "optionGroups": [],
                                    "identifiers": {},
                                    "sourceUrl": "https://example.com/menu",
                                }
                            ],
                        },
                    ],
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["menu"]))

        assert result.menu is not None
        assert len(result.menu.sections) == 2
        assert result.menu.merchant.location == {"city": "Springfield"}
        assert result.menu.sections[0].items[0].dietary[0] == "vegetarian"
        assert result.menu.sections[1].name == "Desserts"
        assert result.menu.sections[1].items[0].images[0].url == "https://example.com/cake.jpg"
        assert result.menu.sections[1].items[0].availability.in_stock is False
        assert result.menu.sections[1].items[0].availability.text == "Sold out"
