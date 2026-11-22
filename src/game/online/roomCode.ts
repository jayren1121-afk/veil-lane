/** Room codes skip look-alike characters (0/O, 1/I/L) so they are easy to read aloud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

function cryptoRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 4294967296;
}

export function generateRoomCode(random: () => number = cryptoRandom): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const index = Math.min(ROOM_CODE_ALPHABET.length - 1, Math.floor(random() * ROOM_CODE_ALPHABET.length));
    code += ROOM_CODE_ALPHABET[index];
  }
  return code;
}

/** Upper-cases and trims user input; returns null when it is not a valid room code. */
export function normalizeRoomCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const code = input.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

export function isValidRoomCode(input: string): boolean {
  return ROOM_CODE_PATTERN.test(input);
}

export const NICKNAME_MAX_LENGTH = 16;

/** Keeps letters, digits, spaces, `_`, `-` and `.`; trims and caps the length. */
export function sanitizeNickname(input: string | null | undefined, fallback = 'Guest'): string {
  const cleaned = (input ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH)
    .trim();
  return cleaned || fallback;
}
