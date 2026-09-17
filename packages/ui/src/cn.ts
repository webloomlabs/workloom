/** Anything `cn` will accept: a class name, or a condition that produced none. */
export type ClassValue = string | false | null | undefined

/** Joins class names, skipping falsy values. */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}
