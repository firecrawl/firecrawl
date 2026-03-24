import pytesseract
from pdf2image import convert_from_path

class PDFOCRProcessor:
    """
    OCR Processor for PDF documents.
    Enables agents to extract text from image-based PDFs.
    """
    @staticmethod
    def process_pdf(file_path):
        print(f"Processing OCR for PDF: {file_path}")
        pages = convert_from_path(file_path)
        text = ""
        for page in pages:
            text += pytesseract.image_to_string(page)
        return text
