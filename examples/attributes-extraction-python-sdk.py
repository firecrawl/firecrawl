"""
Example: Using Firecrawl Python SDK v2 to extract attributes from HTML elements
"""

import os
from firecrawl import FirecrawlApp

def main():
    app = FirecrawlApp(api_key=os.getenv('FIRECRAWL_API_KEY'))

    print('🎯 Extracting attributes from Hacker News...')

    try:
        # Extract story IDs from Hacker News
        result = app.scrape_url('https://news.ycombinator.com', {
            'formats': [
                {'type': 'markdown'},
                {
                    'type': 'attributes',
                    'selectors': [
                        {'selector': '.athing', 'attribute': 'id'}
                    ]
                }
            ]
        })

        if result.get('attributes'):
            story_ids = result['attributes'][0]['values']
            print(f'✅ Success! Found {len(story_ids)} stories')
            print(f'Sample story IDs: {story_ids[:5]}')

        # Example with GitHub - multiple attributes
        print('\n🎯 Extracting multiple attributes from GitHub...')

        github_result = app.scrape_url('https://github.com/microsoft/vscode', {
            'formats': [
                {
                    'type': 'attributes',
                    'selectors': [
                        {'selector': '[data-testid]', 'attribute': 'data-testid'},
                        {'selector': '[data-view-component]', 'attribute': 'data-view-component'}
                    ]
                }
            ]
        })

        if github_result.get('attributes'):
            test_ids = github_result['attributes'][0]['values'] 
            components = github_result['attributes'][1]['values']

            print(f'✅ GitHub extraction success!')
            print(f'Test IDs found: {len(test_ids)}')
            print(f'Components found: {len(components)}')
            print(f'Sample test IDs: {test_ids[:3]}')

    except Exception as error:
        print(f'❌ Error: {error}')

if __name__ == '__main__':
    main()