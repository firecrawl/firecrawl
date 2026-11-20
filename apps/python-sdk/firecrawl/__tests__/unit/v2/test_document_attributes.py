from firecrawl.v2.types import AttributeResult, Document


def test_document_parses_attributes_field():
    doc = Document.model_validate(
        {
            "markdown": "# Header",
            "attributes": [
                {
                    "selector": "a",
                    "attribute": "href",
                    "values": ["https://example.com/a", "https://example.com/b"],
                }
            ],
        }
    )

    assert doc.attributes is not None
    assert len(doc.attributes) == 1
    assert isinstance(doc.attributes[0], AttributeResult)
    assert doc.attributes[0].selector == "a"
    assert doc.attributes[0].attribute == "href"
    assert doc.attributes[0].values == [
        "https://example.com/a",
        "https://example.com/b",
    ]


def test_document_attributes_defaults_to_none():
    doc = Document.model_validate({"markdown": "# Header"})
    assert doc.attributes is None
