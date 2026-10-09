# Test Suite for Firecrawl

This document provides an overview of the test suite for the Firecrawl project. It includes notes on how to interpret the results.

## Overview

The test suite is designed to ensure the reliability and performance of the Firecrawl system. It includes a series of automated tests that check various functionalities and performance metrics.

## Test Results

The tests are designed to cover various aspects of the system, including:

- Crawling accuracy
- Response time
- Error handling

### Example Test Case

- **Test Name**: Accuracy Test
- **Description**: This test checks the accuracy of the scraping mechanism with 100 pages and a fuzzy threshold of 0.8.
- **Expected Result**: Accuracy >= 0.9
- **Received Result**: Accuracy between 0.2 and 0.3

## Troubleshooting

If you encounter any failures or unexpected results, please check the following:
- Ensure your network connection is stable.
- Verify that all dependencies are correctly installed.
- Review the error logs for any specific error messages.

## Contributing

Contributions to the test suite are welcome. Please refer to the project's main [CONTRIBUTING.md](../CONTRIBUTING.md) file for guidelines on how to contribute.