import { error } from './http';
import type { ZodType, ZodTypeDef } from 'zod';

/** Parse a JSON body against a schema, or return the 400 response to send. */
export async function parseBody<T>(request: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());
  return parsed.data;
}
