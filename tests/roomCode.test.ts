import { describe, expect, it } from 'vitest';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  sanitizeNickname,
} from '../src/game/online/roomCode';

describe('room codes', () => {
  it('generates 4 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      for (const char of code) expect(ROOM_CODE_ALPHABET).toContain(char);
    }
  });

  it('excludes look-alike characters', () => {
    for (const char of ['0', 'O', '1', 'I', 'L']) expect(ROOM_CODE_ALPHABET).not.toContain(char);
  });

  it('is deterministic for a given random source and covers the edges', () => {
    expect(generateRoomCode(() => 0)).toBe('AAAA');
    expect(generateRoomCode(() => 0.999999)).toBe('9999');
  });

  it('produces varied codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRoomCode()));
    expect(codes.size).toBeGreaterThan(190);
  });

  it('normalizes user input', () => {
    expect(normalizeRoomCode(' a7k2 ')).toBe('A7K2');
    expect(normalizeRoomCode('A7K')).toBeNull();
    expect(normalizeRoomCode('A0K2')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
  });

  it('sanitizes nicknames', () => {
    expect(sanitizeNickname('  Tai <script>  ')).toBe('Tai script');
    expect(sanitizeNickname('小明_01')).toBe('小明_01');
    expect(sanitizeNickname('')).toBe('Guest');
    expect(sanitizeNickname('x'.repeat(40))).toHaveLength(16);
  });
});
