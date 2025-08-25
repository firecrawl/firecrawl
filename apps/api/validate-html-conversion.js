#!/usr/bin/env node

/**
 * Validation script for HTML-to-Markdown conversion modules
 * Tests both N-API and koffi fallback functionality
 */

const { parseMarkdown } = require('./dist/src/lib/html-to-markdown');

async function runTests() {
  console.log('🧪 Testing HTML-to-Markdown Conversion Modules');
  console.log('='.repeat(50));

  const testCases = [
    {
      name: 'Basic HTML',
      html: '<h1>Hello World</h1><p>This is a <strong>test</strong>.</p>',
      expected: ['# Hello World', '**test**']
    },
    {
      name: 'Complex HTML',
      html: '<div><h2>Section</h2><ul><li>Item 1</li><li>Item 2</li></ul><a href="https://example.com">Link</a></div>',
      expected: ['## Section', '- Item 1', '- Item 2', '[Link](https://example.com)']
    },
    {
      name: 'Empty HTML',
      html: '',
      expected: []
    },
    {
      name: 'Null HTML',
      html: null,
      expected: []
    }
  ];

  let passed = 0;
  let failed = 0;

  // Test with Go parser enabled
  process.env.USE_GO_MARKDOWN_PARSER = 'true';
  console.log('🔧 Testing with USE_GO_MARKDOWN_PARSER=true');

  for (const testCase of testCases) {
    try {
      console.log(`\n📝 Testing: ${testCase.name}`);
      console.log(`   Input: ${testCase.html || 'null'}`);
      
      const result = await parseMarkdown(testCase.html);
      console.log(`   Output: ${result || '(empty)'}`);
      
      // Basic validation
      if (testCase.expected.length === 0) {
        if (result === '') {
          console.log('   ✅ PASS');
          passed++;
        } else {
          console.log('   ❌ FAIL - Expected empty result');
          failed++;
        }
      } else {
        const hasAllExpected = testCase.expected.every(expected => result.includes(expected));
        if (hasAllExpected) {
          console.log('   ✅ PASS');
          passed++;
        } else {
          console.log('   ❌ FAIL - Missing expected content');
          console.log(`   Expected to contain: ${testCase.expected.join(', ')}`);
          failed++;
        }
      }
      
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
      failed++;
    }
  }

  // Test with Go parser disabled (fallback)
  console.log('\n' + '='.repeat(50));
  console.log('🔧 Testing with USE_GO_MARKDOWN_PARSER=false (JavaScript fallback)');
  process.env.USE_GO_MARKDOWN_PARSER = 'false';

  const fallbackTest = testCases[0]; // Just test one case for fallback
  try {
    console.log(`\n📝 Testing: ${fallbackTest.name} (fallback)`);
    const result = await parseMarkdown(fallbackTest.html);
    console.log(`   Output: ${result}`);
    
    const hasAllExpected = fallbackTest.expected.every(expected => result.includes(expected));
    if (hasAllExpected) {
      console.log('   ✅ PASS - Fallback working');
      passed++;
    } else {
      console.log('   ❌ FAIL - Fallback not working properly');
      failed++;
    }
  } catch (error) {
    console.log(`   ❌ ERROR in fallback: ${error.message}`);
    failed++;
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Results:');
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (failed === 0) {
    console.log('🎉 All tests passed! HTML-to-Markdown conversion is working correctly.');
    process.exit(0);
  } else {
    console.log('💥 Some tests failed. Check the configuration and module builds.');
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error('❌ Test runner failed:', error);
  process.exit(1);
});