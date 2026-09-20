import { z } from 'zod';

export const hashtagGroupView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tags: z.array(z.string()),
  createdAt: z.coerce.date(),
});
export type HashtagGroupView = z.infer<typeof hashtagGroupView>;

export const createHashtagGroupInput = z.object({
  name: z.string().min(1).max(100),
  tags: z.array(z.string()).default([]),
});
export type CreateHashtagGroupInput = z.infer<typeof createHashtagGroupInput>;

export const updateHashtagGroupInput = z
  .object({
    name: z.string().min(1).max(100).optional(),
    tags: z.array(z.string()).optional(),
  })
  .refine((input) => input.name !== undefined || input.tags !== undefined, {
    message: 'at least one field is required',
  });
export type UpdateHashtagGroupInput = z.infer<typeof updateHashtagGroupInput>;
