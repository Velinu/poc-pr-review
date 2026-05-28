import * as z from 'zod';

export const CreatePrSchema = z.object({
  repo: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
});

export interface CreatePrDto {
  repo: string;
  head: string;
  base: string;
}
