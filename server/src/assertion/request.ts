const MAX_BODY_BYTES = 16 * 1024;

export function parseTokenRequest(body: string): string | null {
  if (body.length === 0 || body.length > MAX_BODY_BYTES) return null;
  let keys: string[];
  let tokenLiteral: string;
  try {
    const parsed = scanTopLevel(body);
    keys = parsed.keys;
    tokenLiteral = parsed.tokenLiteral;
  } catch {
    return null;
  }
  if (keys.length !== 1 || keys[0] !== "token") return null;
  let token: unknown;
  try {
    token = JSON.parse(tokenLiteral);
  } catch {
    return null;
  }
  if (typeof token !== "string" || token.length === 0) return null;
  return token;
}

function scanTopLevel(text: string): { keys: string[]; tokenLiteral: string } {
  let index = 0;
  const skip = () => {
    while (index < text.length && isWhitespace(text[index]!)) index += 1;
  };
  skip();
  if (text[index] !== "{") throw new Error("shape");
  index += 1;
  skip();
  const keys: string[] = [];
  let tokenLiteral = "";
  if (text[index] === "}") throw new Error("empty");
  for (;;) {
    skip();
    const key = readJsonString(text, () => index, (next) => {
      index = next;
    });
    if (keys.includes(key)) throw new Error("duplicate");
    keys.push(key);
    skip();
    if (text[index] !== ":") throw new Error("colon");
    index += 1;
    skip();
    const valueStart = index;
    skipValue(text, () => index, (next) => {
      index = next;
    });
    if (key === "token") tokenLiteral = text.slice(valueStart, index);
    skip();
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "}") {
      index += 1;
      skip();
      if (index !== text.length) throw new Error("tail");
      return { keys, tokenLiteral };
    }
    throw new Error("end");
  }
}

function readJsonString(text: string, get: () => number, set: (next: number) => void): string {
  let index = get();
  if (text[index] !== "\"") throw new Error("string");
  index += 1;
  let value = "";
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\"") {
      set(index + 1);
      return value;
    }
    if (character === "\\") {
      const parsed = JSON.parse(`"${text.slice(index, endOfStringEscape(text, index))}"`) as string;
      value += parsed;
      index = endOfStringEscape(text, index);
      continue;
    }
    if (character < " ") throw new Error("control");
    value += character;
    index += 1;
  }
  throw new Error("unterminated");
}

function endOfStringEscape(text: string, start: number): number {
  let index = start + 1;
  if (text[index] === "u") return index + 5;
  return index + 1;
}

function skipValue(text: string, get: () => number, set: (next: number) => void): void {
  let index = get();
  const character = text[index];
  if (character === "\"") {
    readJsonString(text, get, set);
    return;
  }
  if (character === "{" || character === "[") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const current = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "\"") inString = false;
        continue;
      }
      if (current === "\"") inString = true;
      else if (current === "{" || current === "[") depth += 1;
      else if (current === "}" || current === "]") {
        depth -= 1;
        if (depth === 0) {
          set(index + 1);
          return;
        }
      }
    }
    throw new Error("value");
  }
  while (index < text.length && text[index] !== "," && text[index] !== "}" && text[index] !== "]" && !isWhitespace(text[index]!)) {
    index += 1;
  }
  if (index === get()) throw new Error("value");
  set(index);
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\n" || character === "\r" || character === "\t";
}
