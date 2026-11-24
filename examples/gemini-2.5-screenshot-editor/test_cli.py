"""Offline regression coverage for the Gemini image response."""

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

with patch("dotenv.load_dotenv"):
    from cli import FirecrawlGeminiEditor


def response(*parts):
    content = SimpleNamespace(parts=parts)
    return SimpleNamespace(candidates=[SimpleNamespace(content=content)])


def image_part(data, *, thought=False):
    return SimpleNamespace(inline_data=SimpleNamespace(data=data), thought=thought)


class FirecrawlGeminiEditorTest(TestCase):
    @patch("cli.genai.Client")
    @patch("cli.Firecrawl")
    def test_returns_final_image_not_interim_image(self, firecrawl, genai_client):
        generate = genai_client.return_value.models.generate_content
        generate.return_value = response(
            image_part(b"interim", thought=True),
            image_part(b"final"),
        )
        editor = FirecrawlGeminiEditor("fixture", "fixture")

        self.assertEqual(editor.generate_image_from_text("A test image"), b"final")
        self.assertEqual(generate.call_args.kwargs["model"], "gemini-3.1-flash-lite-image")
        self.assertEqual(
            generate.call_args.kwargs["config"].response_modalities, ["TEXT", "IMAGE"]
        )
        firecrawl.return_value.scrape.assert_not_called()

    def test_interim_only_response_is_not_a_generated_image(self):
        editor = FirecrawlGeminiEditor.__new__(FirecrawlGeminiEditor)
        editor.verbose = False
        editor.model_name = "gemini-3.1-flash-lite-image"
        editor.client = Mock()
        editor.client.models.generate_content.return_value = response(
            image_part(b"interim", thought=True)
        )

        with self.assertRaisesRegex(Exception, "No image generated"):
            editor.generate_image_from_text("A test image")
