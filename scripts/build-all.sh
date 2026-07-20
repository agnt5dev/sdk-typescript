#!/bin/bash
set -e

echo "🚀 Building AGNT5 TypeScript SDK..."
echo ""

# Build TypeScript first (doesn't depend on bindings)
echo "📘 Building TypeScript..."
npm run build:ts
echo "✅ TypeScript build complete"
echo ""

# NAPI and WASM builds require the Rust toolchain and their dedicated build commands.

echo "⚠️  NAPI and WASM builds skipped"
echo "   To build bindings, you'll need:"
echo "   - Rust toolchain (rustup)"
echo "   - wasm-pack for WASM builds"
echo "   - @napi-rs/cli for NAPI builds"
echo ""

echo "✅ Build complete!"
echo ""
echo "Next steps:"
echo "  - Run tests: npm test"
echo "  - Start dev mode: npm run dev"
