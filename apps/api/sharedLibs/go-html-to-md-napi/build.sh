#!/bin/bash

# Build script for HTML to Markdown N-API module

set -e

echo "🔨 Building HTML to Markdown N-API module..."

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf lib/ build/
mkdir -p lib/

# Build Go static library
echo "📦 Building Go static library..."
go mod download
go build -buildmode=c-archive -o lib/libhtml_converter.a main.go

# Copy header file
cp lib/libhtml_converter.h src/

# Build native addon
echo "🔧 Building native addon..."
npm install
node-gyp rebuild

# Build TypeScript
echo "📜 Building TypeScript..."
npx tsc

echo "✅ Build complete!"
echo "📁 Files created:"
echo "   - lib/libhtml_converter.a (Go static library)"
echo "   - build/Release/html_to_markdown.node (Native addon)"
echo "   - lib/index.js (TypeScript compiled output)"

# Test the build
echo "🧪 Running comprehensive tests..."
node test/test.js