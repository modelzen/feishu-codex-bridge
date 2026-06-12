/** Drain process stdin to a string. Resolves '' immediately on a TTY so a
 *  command launched interactively (no piped input) doesn't hang forever waiting
 *  for an 'end' that never comes. Shared by the secrets exec-provider and the
 *  CLI hook bridge. */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}
