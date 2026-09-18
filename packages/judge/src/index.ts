/** Only normalize CRLF and allow one final newline difference. Other whitespace is significant. */
export function compareOutput(actual: string, expected: string): boolean {
  const normalize = (value: string) => value.replace(/\r\n/g, '\n');
  const a = normalize(actual);
  const e = normalize(expected);
  return a === e || a === `${e}\n` || `${a}\n` === e;
}
