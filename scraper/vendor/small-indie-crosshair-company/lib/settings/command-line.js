/** The CS2 console accepts at most this many characters per pasted line. */
export const CONSOLE_LINE_LIMIT = 510;

/**
 * Join console commands into one pasteable line: comments and blanks dropped, `;` between commands.
 * @param {string[]} lines - commands, possibly mixed with `//` comment lines.
 * @returns {string} one line without comments or newlines.
 * @throws {Error} if the line is longer than CONSOLE_LINE_LIMIT.
 */
export function commandLine(lines) {
  const line = lines.map(l => l.trim()).filter(l => l && !l.startsWith('//')).join(';');
  if (line.length > CONSOLE_LINE_LIMIT)
    throw new Error(`Command line is ${line.length} characters; the console accepts ${CONSOLE_LINE_LIMIT}.`);
  return line;
}
