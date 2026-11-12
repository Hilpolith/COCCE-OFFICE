export function hasControlCharacters(value: string, preserveWhitespaceControls = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f || (code < 0x20 && !(preserveWhitespaceControls && (code === 0x09 || code === 0x0a || code === 0x0d)))) return true;
  }
  return false;
}

export function stripControlCharacters(value: string, preserveWhitespaceControls = false): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (code === 0x7f || (code < 0x20 && !(preserveWhitespaceControls && (code === 0x09 || code === 0x0a || code === 0x0d)))) continue;
    result += character;
  }
  return result;
}
