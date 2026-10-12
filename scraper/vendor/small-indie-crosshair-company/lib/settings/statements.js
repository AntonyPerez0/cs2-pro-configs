/** Split data-only console statements. `;` and // comments count only outside quoted values; a line break always
 * ends the statement and closes an open quote, as the game's command buffer does, so one stray quote cannot swallow
 * later lines. Escaped quotes/backslashes stay inside their value, so bind/alias bodies are never promoted. */
export function cfgStatements(input) {
  const statements = [];
  let statement = '', quoted = false, comment = false;
  const flush = () => { statements.push(statement); statement = ''; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i], next = input[i + 1];
    if (comment) {
      if (char === '\n' || char === '\r') { comment = false; flush(); }
      continue;
    }
    if (char === '\n' || char === '\r') { quoted = false; flush(); continue; }
    if (quoted && char === '\\' && next !== undefined && next !== '\n' && next !== '\r') {
      statement += char + next; i++; continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '/' && next === '/') { comment = true; i++; continue; }
    if (!quoted && char === ';') { flush(); continue; }
    statement += char;
  }
  flush();
  return statements;
}
