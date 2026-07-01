import { serve, workflow } from '../src/index.js';

const hello = workflow('hello', async (_ctx, input: { name: string }) => ({
  message: `hello ${input.name}`,
}));

export default serve({
  serviceName: 'workerless-http-example',
  serviceVersion: 'm1',
  workflows: [hello],
});
