import re
import json

def firecrawl_financial_extractor(html_text):
    """
    Analyzes messy web text to extract currency, 
    amounts, and priority levels.
    """
    # Initialize the data structure
    extracted_data = {
        "currency": "Unknown",
        "amount": 0,
        "priority": "Low"
    }

    # 1. Logic for Currency Detection (INR/USD)
    text_lower = html_text.lower()
    if "₹" in html_text or "rs" in text_lower:
        extracted_data["currency"] = "INR"
    elif "$" in html_text:
        extracted_data["currency"] = "USD"

    # 2. Logic for Amount Extraction (Handles commas like 60,000)
    # This regex looks for digits and optional commas
    raw_numbers = re.findall(r'\d+(?:,\d+)?', html_text)
    if raw_numbers:
        # Remove commas and convert to integers to find the largest value
        clean_numbers = [int(num.replace(',', '')) for num in raw_numbers]
        extracted_data["amount"] = max(clean_numbers)

    # 3. Urgency Detection for Financial Deadlines
    urgent_terms = ["urgent", "fees", "rent", "deadline", "pay"]
    if any(term in text_lower for term in urgent_terms):
        extracted_data["priority"] = "High"

    return json.dumps(extracted_data, indent=4)

# Example usage for verification:
if __name__ == "__main__":
    TEST_INPUT = "Admission Open! Total School Fees: ₹60,000. Pay before Tuesday."
    print(firecrawl_financial_extractor(TEST_INPUT))
