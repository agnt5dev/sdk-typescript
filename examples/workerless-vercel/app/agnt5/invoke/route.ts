import { agnt5Workerless } from '../../../src/agnt5-workerless';

export const runtime = 'nodejs';
export const maxDuration = 25;

export function POST(request: Request): Promise<Response> {
  return agnt5Workerless.fetch(request);
}
