import type { FunctionHandler, FunctionOptions } from './types.js';

export class FunctionRegistry {
  private static functions = new Map<
    string,
    { handler: FunctionHandler; options: FunctionOptions }
  >();

  static register(
    name: string,
    config: { handler: FunctionHandler; options: FunctionOptions },
  ): void {
    this.functions.set(name, config);
  }

  static get(name: string): { handler: FunctionHandler; options: FunctionOptions } | undefined {
    return this.functions.get(name);
  }

  static getAll(): [string, { handler: FunctionHandler; options: FunctionOptions }][] {
    return Array.from(this.functions.entries());
  }

  static clear(): void {
    this.functions.clear();
  }
}
