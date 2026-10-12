import { z } from 'zod';

export const addClientPersonInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['admin', 'member', 'viewer']),
});
export type AddClientPersonInput = z.infer<typeof addClientPersonInput>;
export interface ClientPersonView {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}
export interface CreatedClientPersonView {
  person: ClientPersonView;
  temporaryPassword: string;
}
