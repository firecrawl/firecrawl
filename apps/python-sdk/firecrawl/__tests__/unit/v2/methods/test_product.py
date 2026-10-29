import pytest
from unittest.mock import Mock
from firecrawl.v2.methods.scrape import scrape
from firecrawl.v2.types import ScrapeOptions


class TestProductFormat:
    """Unit tests for product format support."""

    def test_scrape_with_product_format_returns_product_data(self):
        """Test that scraping with product format returns product data."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Example Product",
                "product": {
                    "title": "Acme Running Shoe",
                    "brand": "Acme",
                    "category": "Footwear",
                    "url": "https://example.com/shoe",
                    "description": "A lightweight running shoe.",
                    "variants": [
                        {
                            "id": "default",
                            "values": {"size": "10"},
                            "price": {"amount": 89.99, "currency": "USD", "formatted": "$89.99"},
                            "sale": {"originalPrice": {"amount": 129.99, "currency": "USD"}},
                            "availability": {"inStock": True, "text": "In stock"},
                            "images": [{"url": "https://example.com/shoe.jpg", "alt": "Acme shoe"}],
                        }
                    ]
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["product"]))

        assert result.product is not None
        assert result.product.title == "Acme Running Shoe"
        assert result.product.brand == "Acme"
        assert result.product.category == "Footwear"
        variant = result.product.variants[0]
        assert variant.price.amount == 89.99
        assert variant.price.currency == "USD"
        assert variant.sale.original_price.amount == 129.99
        assert variant.sale.original_price.currency == "USD"
        assert variant.availability.in_stock is True
        assert variant.availability.text == "In stock"
        assert variant.images[0].url == "https://example.com/shoe.jpg"

    def test_scrape_with_product_and_markdown_formats_returns_both(self):
        """Test that scraping with both product and markdown formats returns both."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Example Content",
                "product": {
                    "title": "Acme Mug",
                    "url": "https://example.com/mug",
                    "variants": [
                        {
                            "price": {"amount": 12.5, "currency": "USD"},
                            "availability": {"inStock": True}
                        }
                    ]
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["markdown", "product"]))

        assert result.markdown == "# Example Content"
        assert result.product is not None
        assert result.product.title == "Acme Mug"
        assert result.product.variants[0].price.amount == 12.5

    def test_scrape_without_product_format_does_not_return_product(self):
        """Test that scraping without product format does not return product."""
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
        assert result.product is None

    def test_non_product_page_yields_warning_and_no_product(self):
        """Test that a non-product page scraped with product format yields a warning and no product."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "markdown": "# Blog Post",
                "warning": "No product found on this page."
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["product"]))

        assert result.product is None
        assert "No product found" in result.warning

    def test_product_format_with_variants_populated(self):
        """Test product format with variants populated, including camelCase aliasing."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "data": {
                "product": {
                    "title": "Acme T-Shirt",
                    "brand": "Acme",
                    "url": "https://example.com/tshirt",
                    "variants": [
                        {
                            "id": "v1",
                            "sku": "TSHIRT-S-RED",
                            "title": "Small / Red",
                            "values": {"size": "S", "color": "Red"},
                            "price": {"amount": 24.0, "currency": "USD"},
                            "availability": {"inStock": True},
                            "images": [{"url": "https://example.com/tshirt-red.jpg"}]
                        },
                        {
                            "id": "v2",
                            "sku": "TSHIRT-L-BLUE",
                            "title": "Large / Blue",
                            "values": {"size": "L", "color": "Blue"},
                            "availability": {"inStock": False, "text": "Sold out"}
                        }
                    ]
                }
            }
        }

        mock_client = Mock()
        mock_client.post.return_value = mock_response

        result = scrape(mock_client, "https://example.com", ScrapeOptions(formats=["product"]))

        assert result.product is not None
        assert len(result.product.variants) == 2
        assert result.product.variants[0].sku == "TSHIRT-S-RED"
        assert result.product.variants[0].values["color"] == "Red"
        assert result.product.variants[0].availability.in_stock is True
        assert result.product.variants[0].images[0].url == "https://example.com/tshirt-red.jpg"
        assert result.product.variants[1].availability.in_stock is False
        assert result.product.variants[1].availability.text == "Sold out"
