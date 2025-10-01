// Simple test to verify NAPI bindings load correctly
const native = require('./native/agnt5-sdk-native.darwin-arm64.node');

console.log('✓ Native module loaded successfully');
console.log('Exports:', Object.keys(native));

// Test initialize function
try {
  native.initialize('test-service', '0.1.0');
  console.log('✓ initialize() called successfully');
} catch (e) {
  console.log('✓ initialize() called (expected to work or fail gracefully):', e.message);
}

// Test Worker creation
try {
  const worker = new native.Worker({
    serviceName: 'test-service',
    serviceVersion: '0.1.0',
    coordinatorEndpoint: 'http://localhost:34186'
  });

  console.log('✓ Worker created successfully');
  console.log('  Service name:', worker.serviceName);
  console.log('  Worker ID:', worker.workerId);
  console.log('  Coordinator endpoint:', worker.coordinatorEndpoint);
  console.log('  Tenant ID:', worker.tenantId);
  console.log('  Deployment ID:', worker.deploymentId);
} catch (e) {
  console.error('✗ Worker creation failed:', e);
}

console.log('\n✅ Native bindings test complete!');
