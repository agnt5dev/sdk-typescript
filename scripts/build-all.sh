#!/bin/bash
set -e

echo "🚀 Building AGNT5 TypeScript SDK..."
echo ""

# Build TypeScript first (doesn't depend on bindings)
echo "📘 Building TypeScript..."
npm run build:ts
echo "✅ TypeScript build complete"
echo ""

# Note: NAPI and WASM builds require Rust toolchain
# These will be set up in Phase 2 when we integrate with sdk-core

echo "⚠️  NAPI and WASM builds skipped (Phase 2)"
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
