/**
 * Example: Using Firecrawl JS SDK v2 to extract attributes from HTML elements
 */

import { Firecrawl } from 'firecrawl';

const app = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });

async function main() {
  console.log('🎯 Extracting attributes from Hacker News...');

  try {
    // Extract story IDs from Hacker News
    const result = await app.scrape('https://news.ycombinator.com', {
      formats: [
        { type: 'markdown' },
        {
          type: 'attributes',
          selectors: [
            { selector: '.athing', attribute: 'id' }
          ]
        }
      ]
    });

    console.log('✅ Success! Extracted data:');
    console.log('Story IDs:', result.attributes[0].values.slice(0, 5));
    console.log('Total stories found:', result.attributes[0].values.length);

    // Example with GitHub - multiple attributes
    console.log('\n🎯 Extracting multiple attributes from GitHub...');

    const githubResult = await app.scrape('https://github.com/microsoft/vscode', {
      formats: [
        {
          type: 'attributes',
          selectors: [
            { selector: '[data-testid]', attribute: 'data-testid' },
            { selector: '[data-view-component]', attribute: 'data-view-component' }
          ]
        }
      ]
    });

    console.log('✅ GitHub extraction success!');
    console.log('Test IDs found:', githubResult.attributes[0].values.length);
    console.log('Components found:', githubResult.attributes[1].values.length);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

main();