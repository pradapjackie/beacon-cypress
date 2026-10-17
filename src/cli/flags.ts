/** The first leftover flag after known options have been removed. */
export function unknownOption(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith('-'));
}
