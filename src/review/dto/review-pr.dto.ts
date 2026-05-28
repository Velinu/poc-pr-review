import * as z from 'zod';

export const ReviewPrSchema = z.object({
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
});

export interface ReviewPrDto {
  repo: string;
  pull_number: number;
}
