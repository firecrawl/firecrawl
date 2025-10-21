/**
 * Test script to verify anti-detection features are working
 * Run with: node test-anti-detection.js
 */

const http = require('http');

const PLAYWRIGHT_SERVICE_URL = process.env.PLAYWRIGHT_SERVICE_URL || 'http://localhost:3003';

// Test URLs that detect bots
const TEST_URLS = [
  {
    name: 'Sannysoft Bot Detector',
    url: 'https://bot.sannysoft.com/',
    checkFor: 'navigator.webdriver',
    shouldNotContain: 'present'
  },
  {
    name: 'BrowserLeaks WebRTC',
    url: 'https://browserleaks.com/webrtc',
    checkFor: 'IP Address',
    shouldNotContain: null
  },
  {
    name: 'CloudFlare Test',
    url: 'https://nowsecure.nl/',
    checkFor: 'Checking your browser',
    shouldNotContain: 'blocked'
  }
];

async function testScrape(testCase) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      url: testCase.url,
      wait_after_load: 2000,
      timeout: 30000
    });

    const options = {
      hostname: new URL(PLAYWRIGHT_SERVICE_URL).hostname,
      port: new URL(PLAYWRIGHT_SERVICE_URL).port || 3003,
      path: '/scrape',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Testing Anti-Detection Features\n');
  console.log('=' .repeat(60));
  
  let passed = 0;
  let failed = 0;

  for (const testCase of TEST_URLS) {
    console.log(`\n📍 Testing: ${testCase.name}`);
    console.log(`   URL: ${testCase.url}`);
    
    try {
      const result = await testScrape(testCase);
      
      if (result.pageStatusCode && result.pageStatusCode === 200) {
        console.log(`   ✅ Status: ${result.pageStatusCode} OK`);
        
        // Check content
        if (testCase.shouldNotContain) {
          if (result.content.toLowerCase().includes(testCase.shouldNotContain.toLowerCase())) {
            console.log(`   ❌ FAILED: Content contains "${testCase.shouldNotContain}"`);
            failed++;
          } else {
            console.log(`   ✅ PASSED: Content does not contain "${testCase.shouldNotContain}"`);
            passed++;
          }
        } else {
          console.log(`   ✅ PASSED: Successfully scraped`);
          passed++;
        }
      } else {
        console.log(`   ⚠️  Status: ${result.pageStatusCode || 'Unknown'}`);
        if (result.pageError) {
          console.log(`   Error: ${result.pageError}`);
        }
        failed++;
      }
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  
  if (failed === 0) {
    console.log('🎉 All tests passed! Anti-detection is working correctly.\n');
  } else {
    console.log('⚠️  Some tests failed. Review the output above.\n');
  }
}

// Health check first
async function checkHealth() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: new URL(PLAYWRIGHT_SERVICE_URL).hostname,
      port: new URL(PLAYWRIGHT_SERVICE_URL).port || 3003,
      path: '/health',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      resolve(res.statusCode === 200);
    });

    req.on('error', () => {
      resolve(false);
    });

    req.end();
  });
}

async function main() {
  console.log('🔍 Checking Playwright service health...');
  const healthy = await checkHealth();
  
  if (!healthy) {
    console.error('❌ Playwright service is not responding at', PLAYWRIGHT_SERVICE_URL);
    console.error('   Make sure the service is running:');
    console.error('   cd apps/playwright-service-ts && npm run dev');
    process.exit(1);
  }
  
  console.log('✅ Playwright service is healthy\n');
  
  await runTests();
}

main();
