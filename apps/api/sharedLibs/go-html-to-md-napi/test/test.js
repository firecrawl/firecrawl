#!/usr/bin/env node

const path = require('path');

// Test basic loading
console.log('🧪 Testing N-API HTML-to-Markdown module...');

try {
  const addonPath = path.join(__dirname, '..', 'build', 'Release', 'html_to_markdown.node');
  console.log('📂 Loading module from:', addonPath);
  
  const addon = require(addonPath);
  console.log('✅ Module loaded successfully');
  
  // Test basic conversion
  const testHtml = '<h1>Hello World</h1><p>This is a <strong>test</strong> paragraph.</p>';
  console.log('🔄 Testing conversion...');
  console.log('Input HTML:', testHtml);
  
  const result = addon.convertSync(testHtml);
  console.log('Output Markdown:', result);
  
  // Validate output
  if (result.includes('# Hello World') && result.includes('**test**')) {
    console.log('✅ Conversion test passed!');
  } else {
    console.log('❌ Conversion test failed - unexpected output');
    process.exit(1);
  }
  
  // Test error handling
  console.log('🔄 Testing error handling...');
  try {
    addon.convertSync();
    console.log('❌ Error handling test failed - should have thrown');
    process.exit(1);
  } catch (error) {
    console.log('✅ Error handling test passed:', error.message);
  }
  
  console.log('🎉 All tests passed!');
  
} catch (error) {
  console.error('❌ Test failed:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}