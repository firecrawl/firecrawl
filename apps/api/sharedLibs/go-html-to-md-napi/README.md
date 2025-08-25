# HTML to Markdown N-API Module

A stable N-API wrapper around the Go HTML-to-Markdown library, replacing the problematic koffi implementation.

## Features

- ✅ **Thread-safe**: Uses mutex to prevent race conditions
- ✅ **Timeout protection**: 30-second timeout prevents hanging
- ✅ **Memory safe**: Proper memory management with no leaks
- ✅ **Stable**: N-API provides stable ABI across Node.js versions
- ✅ **Fallback**: Graceful fallback to JavaScript implementation
- ✅ **Async support**: Both sync and async interfaces

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   TypeScript    │───▶│   N-API (C++)   │───▶│   Go Library    │
│   Application   │    │   Wrapper       │    │   (Static Lib)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Build Requirements

- Node.js 16+ with N-API support
- Go 1.23+
- C++ compiler (gcc/clang/MSVC)
- Python 3.x (for node-gyp)

## Building

```bash
# Install dependencies
npm install

# Build everything (Go + Native + TypeScript)
./build.sh

# Or build step by step:
npm run build:go      # Build Go static library
npm run build:native  # Build N-API addon
npm run build:ts      # Compile TypeScript
```

## Usage

### TypeScript Integration

```typescript
import { parseMarkdownNAPI } from './html-to-markdown-napi';

// Use as drop-in replacement for parseMarkdown
const markdown = await parseMarkdownNAPI('<h1>Hello World</h1>');
```

### Direct N-API Usage

```javascript
const addon = require('./build/Release/html_to_markdown');

// Synchronous
const result = addon.convertSync('<h1>Hello</h1>');

// Asynchronous
addon.convertAsync('<h1>Hello</h1>', (err, result) => {
  if (err) throw err;
  console.log(result);
});
```

## Environment Variables

- `USE_GO_MARKDOWN_PARSER=true` - Enable N-API module (with fallback)

## Error Handling

The module includes multiple layers of error handling:

1. **Module loading**: Falls back to JavaScript if N-API module fails to load
2. **Conversion timeout**: 30-second timeout prevents hanging
3. **Go-level errors**: Converted to JavaScript errors
4. **Memory management**: Automatic cleanup of C strings

## Performance

N-API offers better performance characteristics than koffi:

- **Lower overhead**: Direct C++ interface vs FFI layer
- **Memory efficiency**: No repeated library loading
- **Stability**: No CGO interaction issues
- **Thread safety**: Built-in mutex protection

## Migration from koffi

1. Build the N-API module: `./build.sh`
2. Replace imports:
   ```typescript
   // Before
   import { parseMarkdown } from './html-to-markdown';
   
   // After  
   import { parseMarkdownNAPI as parseMarkdown } from './html-to-markdown-napi';
   ```
3. Set environment variable: `USE_GO_MARKDOWN_PARSER=true`

The new implementation is a drop-in replacement with the same API.

## Troubleshooting

### Build Issues

```bash
# Clean and rebuild
npm run clean
./build.sh
```

### Module Loading Issues

Check the logs for:
- File permissions on `.node` file
- Missing dependencies
- Architecture mismatches

### Runtime Issues

The module includes extensive logging and will fall back to JavaScript implementation if any issues occur.