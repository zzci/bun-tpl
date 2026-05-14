import { customAlphabet } from "nanoid";

const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz";
const NANOID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const randomChars = customAlphabet(ENCODING, 16);

export const nanoid = customAlphabet(NANOID_ALPHABET, 8);

function encodeTime(now: number): string {
  let time = now;
  const chars: string[] = [];
  for (let i = 0; i < 10; i++) {
    chars.unshift(ENCODING[time % 32]!);
    time = Math.floor(time / 32);
  }
  return chars.join("");
}

export function ulid(): string {
  return encodeTime(Date.now()) + randomChars();
}
