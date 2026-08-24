import { agnt5Workerless } from '../../../src/agnt5-workerless';

export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return agnt5Workerless.fetch(request);
}
