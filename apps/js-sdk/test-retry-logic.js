// Test script to demonstrate the network retry functionality
// This would be used to verify the fix for issue #1912

// Mock implementation to simulate the retry logic we added
class NetworkRetryDemo {
  constructor() {
    this.maxRetries = 3;
    this.baseDelay = 1000;
  }

  isRetryableError(error) {
    if (error.code) {
      return [
        'ECONNRESET',
        'ETIMEDOUT', 
        'ENOTFOUND',
        'ECONNREFUSED'
      ].includes(error.code);
    }
    
    if (error.response?.status) {
      // Only retry on status codes that are safe and won't cause double billing
      return [408, 429].includes(error.response.status);
    }
    
    const message = error.message?.toLowerCase() || '';
    return message.includes('socket hang up') || 
           message.includes('network error') || 
           message.includes('timeout');
  }

  calculateBackoffDelay(attempt, baseDelay) {
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * exponentialDelay;
    return Math.min(exponentialDelay + jitter, 30000);
  }

  async scrapeUrlWithRetry(url, params = {}) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`Attempt ${attempt + 1}/${this.maxRetries + 1} for ${url}`);
        
        // Simulate API call (would be actual axios.post in real implementation)
        const response = await this.makeApiCall(url, params);
        
        if (response.status === 200) {
          console.log('✅ Success on attempt', attempt + 1);
          return {
            success: true,
            data: response.data,
            attempts: attempt + 1
          };
        } else if (this.isRetryableHttpStatus(response.status) && attempt < this.maxRetries) {
          lastError = new Error(`HTTP ${response.status}: Server error`);
          const delay = this.calculateBackoffDelay(attempt, this.baseDelay);
          console.log(`⏳ Retrying in ${Math.round(delay)}ms due to HTTP ${response.status}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          throw new Error(`Non-retryable HTTP error: ${response.status}`);
        }
      } catch (error) {
        lastError = error;
        
        if (this.isRetryableError(error) && attempt < this.maxRetries) {
          const delay = this.calculateBackoffDelay(attempt, this.baseDelay);
          console.log(`⏳ Retrying in ${Math.round(delay)}ms due to: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Non-retryable error or final attempt
        throw new Error(`Failed after ${attempt + 1} attempts. Last error: ${error.message}`);
      }
    }
    
    throw new Error(`All ${this.maxRetries + 1} attempts failed. Last error: ${lastError?.message}`);
  }

  isRetryableHttpStatus(status) {
    // Only retry on status codes that are safe and won't cause double billing:
    // 408 Request Timeout - server explicitly didn't process the request
    // 429 Too Many Requests - rate limited, request wasn't processed
    // Note: 5xx errors (502, 503, 504) are NOT retried to prevent double billing
    return [408, 429].includes(status);
  }

  // Simulate different network conditions
  async makeApiCall(url, params) {
    const random = Math.random();
    
    // Simulate various failure scenarios
    if (random < 0.3) {
      // 30% chance of network timeout
      const error = new Error('socket hang up');
      error.code = 'ECONNRESET';
      throw error;
    } else if (random < 0.5) {
      // 20% chance of server error
      return {
        status: 503,
        data: { error: 'Service temporarily unavailable' }
      };
    } else if (random < 0.7) {
      // 20% chance of timeout
      const error = new Error('timeout of 30000ms exceeded');
      error.code = 'ETIMEDOUT';
      throw error;
    } else {
      // 30% chance of success
      return {
        status: 200,
        data: {
          success: true,
          markdown: '# Sample scraped content',
          url: url
        }
      };
    }
  }
}

// Demo function
async function demonstrateRetryLogic() {
  console.log('🚀 Demonstrating Network Retry Logic for Firecrawl SDK\n');
  console.log('This simulates the fix for issue #1912: Intermittent network errors\n');
  
  const demo = new NetworkRetryDemo();
  
  try {
    const result = await demo.scrapeUrlWithRetry('https://example.com', {
      formats: ['json'],
      timeout: 30000
    });
    
    console.log('\n✅ Final Result:', {
      success: result.success,
      attempts: result.attempts,
      url: result.data.url
    });
    
  } catch (error) {
    console.log('\n❌ Final Error:', error.message);
  }
  
  console.log('\n📝 Summary of improvements:');
  console.log('1. ✅ Automatic retry on network errors (ECONNRESET, ETIMEDOUT, etc.)');
  console.log('2. ✅ Exponential backoff with jitter to avoid thundering herd');
  console.log('3. ✅ Configurable retry attempts (default: 3)');
  console.log('4. ✅ Better error messages with context');
  console.log('5. ✅ Retryable HTTP status codes (408, 429) - 5xx codes removed to prevent double billing');
  console.log('6. ✅ Timeout improvements (default 30s)');
}

// Run the demo
demonstrateRetryLogic().catch(console.error);