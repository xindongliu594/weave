/** Recognize standalone Node syntax checks only, not arbitrary shell semantics. */
export function isNodeSyntaxCheck(command: string): boolean {
  const match = /^\s*node(?:\.exe)?\s+(.+?)\s*$/i.exec(command);
  if (!match || /[;&|<>\r\n`$]/.test(match[1])) return false;
  const tokens = (match[1].match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/, '$2'));
  const valueOptions = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title', '--icu-data-dir']);
  // Flags after the script/-- are script arguments; an eval string is not a flag.
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--check' || token === '-c') return true;
    if (!token.startsWith('-') || token === '--' || ['-e', '--eval', '-p', '--print'].includes(token)) return false;
    if (valueOptions.has(token)) index++;
  }
  return false;
}
