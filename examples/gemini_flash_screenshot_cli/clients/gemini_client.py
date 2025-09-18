import os
from google import genai
from PIL import Image
from io import BytesIO

class GeminiClient:
    def __init__(self, api_key: str, model: str = "gemini-2.5-flash-image-preview"):

        self.client = genai.Client(api_key=api_key)
        self.model = model

    def edit_image(self, image_bytes: bytes, prompt: str, high_quality: bool = True) -> bytes:
        """
        Send image + prompt to Gemini Flash API and return edited image bytes.
        """
        
        if high_quality:
            prompt += """
            QUALITY:
            - Ultra high resolution
            - Sharp details
            - Rich color depth
            - Professional/artistic quality
            """

        image = Image.open(BytesIO(image_bytes))
        
        response = self.client.models.generate_content(
            model=self.model,
            contents=[prompt, image]
        )

        parts = [p.inline_data.data for p in response.candidates[0].content.parts if p.inline_data]
        if not parts:
            return image_bytes
        return parts[0]

    def generate_image(self, prompt: str, high_quality: bool = True) -> bytes:
        """
        Generate an image from text using Gemini Flash.
        """
        
        if high_quality:
            prompt += """
            QUALITY:
            - Ultra high resolution
            - Sharp details
            - Rich color depth
            - Professional/artistic quality
            """

        response = self.client.models.generate_content(model=self.model, contents=prompt)
        parts = [p.inline_data.data for p in response.candidates[0].content.parts if p.inline_data]

        if not parts:
            raise Exception("No image generated")
        return parts[0]
