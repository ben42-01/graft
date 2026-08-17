import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges Tailwind class lists, resolving conflicting utility classes in favour
 * of the last one specified. Standard shadcn/ui helper — every vendored
 * component in src/components/ui imports this to compose its own class list
 * with a caller-supplied `className` override.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
